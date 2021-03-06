import {
    BackendAdapter,
    BackendEvent,
    MapIdModel,
    PublicLobbyBackendModel,
    PublicLobbyRegion,
    RoomGroup
} from "../types/Backend";
import {
    AmongusClient,
    BufferReader,
    DebugOptions,
    LerpValue,
    MapID,
    MasterServers,
    MessageID,
    PacketID,
    PayloadID,
    RPCID,
    SpawnID
} from "../../amongus-protocol/ts";
import {
    GameDataMessage,
    GameDataPayload,
    GameDataToPayload,
    Payload,
    PlayerSpawn,
    RPCMessage,
    SpawnMessage
} from "../../amongus-protocol/ts/lib/interfaces/Packets";

export default class PublicLobbyBackend extends BackendAdapter {
    backendModel: PublicLobbyBackendModel
    constructor(backendModel: PublicLobbyBackendModel) {
        super();
        this.backendModel = backendModel;
    }

    playerData: {
        name: string;
        clientId: number;
        playerId: number;
        controlNetId: number;
        transformNetId: number;
    }[] = [];
    client: AmongusClient;
    currentMap: MapID;
    shipStatusNetId = -1;

    async initialize(): Promise<void> {
        try {
            // connect
            // keep trying to join game
            // on game start => event
            // on player move => event
            // on meeting called => event
            // on player murdered and exiled => event
            // on game finish => event
            // rejoin game
            let servers;
            if (this.backendModel.region === PublicLobbyRegion.NorthAmerica) {
                servers = MasterServers.NA[0];
            } else if (this.backendModel.region === PublicLobbyRegion.Europe) {
                servers = MasterServers.EU[0];
            } else if (this.backendModel.region === PublicLobbyRegion.Asia) {
                servers = MasterServers.AS[0];
            }

            await this.firstSpawn(servers);

            // restart new client
            this.client = new AmongusClient({
                debug: DebugOptions.None
            });
            this.client.on("packet", packet => {
                // console.log(util.inspect(packet, false, 10, true));
                if (packet.op === PacketID.Reliable || packet.op === PacketID.Unreliable) {
                    packet.payloads.forEach(async payload => await handlePayload(payload));
                }
            });

            const handlePayload = async (payload: Payload) => {
                if (payload.payloadid === PayloadID.StartGame) {
                    this.emitAllPlayerJoinGroups(RoomGroup.Main);
                    console.log("started game");
                } else if (payload.payloadid === PayloadID.EndGame) {
                    this.emitAllPlayerJoinGroups(RoomGroup.Spectator);
                    this.client.game = null;
                    await this.firstSpawn(servers);
                    await this.client.join(this.backendModel.gameCode, {
                        doSpawn: false
                    });
                    console.log("ended game");
                } else if (payload.payloadid === PayloadID.RemovePlayer) {
                    this.playerData = this.playerData.filter(p => p.clientId !== payload.clientid);
                    // Handler for if the game sets us to host. Might be a hacky way.
                    if (payload.clientid === this.client.clientid) {
                        await this.client.disconnect();
                        await this.client.connect(servers[0], servers[1], "auproximity");
                        await this.client.join(this.backendModel.gameCode, {
                            doSpawn: false
                        });
                    }
                    console.log("removed player");
                } else if (payload.payloadid === PayloadID.GameData || payload.payloadid === PayloadID.GameDataTo) {
                    (payload as (GameDataPayload | GameDataToPayload)).parts.forEach(part => {
                        handleGameDataPart(part);
                    });
                }
            };

            const handleGameDataPart = (part: GameDataMessage) => {
                if (part.type == MessageID.Data) {
                    const player = this.playerData.find(p => p.transformNetId === part.netid);
                    if (player) {
                        const reader = new BufferReader(part.data);
                        reader.uint16LE();
                        const pose = {
                            x: LerpValue(reader.uint16LE() / 65535, -40, 40),
                            y: LerpValue(reader.uint16LE() / 65535, -40, 40)
                        };
                        this.emitPlayerPose(player.name, pose);
                    }
                    if (part.netid === this.shipStatusNetId) {
                        const reader = new BufferReader(part.data);
                        const systemsMask = reader.packed();
                        // if the systemsMask contains communication
                        if ((systemsMask & (1 << 14)) != 0) {
                           if (this.currentMap === MapID.TheSkeld ||
                               this.currentMap === MapID.Polus) {
                               // if it is sabotaged
                               if (reader.bool()) {
                                   this.emitPlayerFromJoinGroup(RoomGroup.Main, RoomGroup.Muted);
                               } else {
                                   this.emitPlayerFromJoinGroup(RoomGroup.Muted, RoomGroup.Main);
                               }
                           } else if (this.currentMap === MapID.MiraHQ) {
                                for (let i; i < reader.packed(); i++) {
                                    reader.byte();
                                    reader.byte();
                                }
                                const consoleCount = reader.packed();
                                if (consoleCount === 0) {
                                    this.emitPlayerFromJoinGroup(RoomGroup.Main, RoomGroup.Muted);
                                }
                                if (reader.packed() == 2 && reader.bool() == true && reader.bool() == true) {
                                    this.emitPlayerFromJoinGroup(RoomGroup.Muted, RoomGroup.Main);
                                }
                           }
                        }
                    }
                } else if (part.type == MessageID.RPC) {
                    handleRPC(part as RPCMessage);
                } else if (part.type == MessageID.Spawn) {
                    handleSpawnMessage(part as SpawnMessage);
                }
            };

            const handleRPC = (rpcPart: RPCMessage) => {
                if (rpcPart.rpcid === RPCID.StartMeeting) {
                    setTimeout(() => {
                        this.emitAllPlayerPoses({ x: 0, y: 0 });
                    }, 2500);
                    console.log("meeting started");
                } else if (rpcPart.rpcid === RPCID.VotingComplete) {
                    console.log("meeting ended with rpc packet: ", rpcPart);
                    console.log("current playerData: ", this.playerData);
                    if (rpcPart.exiled !== 0xff) {
                        setTimeout(() => {
                            const player = this.playerData.find(p => p.playerId === rpcPart.exiled);
                            if (player) {
                                this.emitPlayerJoinGroup(player.name, RoomGroup.Spectator);
                                console.log("voted off: " + player.name);
                            }
                        }, 2500);
                    }
                } else if (rpcPart.rpcid === RPCID.MurderPlayer) {
                    const player = this.playerData.find(p => p.controlNetId === rpcPart.targetnetid);
                    if (player) this.emitPlayerJoinGroup(player.name, RoomGroup.Spectator);
                    console.log("murdered " + player.name);
                } else if (rpcPart.rpcid === RPCID.SetName) {
                    const player = this.playerData.find(p => p.controlNetId === rpcPart.handlerid);
                    if (player) {
                        player.name = rpcPart.name;
                    } else {
                        this.playerData.push({
                            name: rpcPart.name,
                            controlNetId: rpcPart.handlerid,
                            playerId: -1,
                            clientId: -1,
                            transformNetId: -1
                        });
                    }
                    console.log("set someone name to: " + rpcPart.name);
                } else if (rpcPart.rpcid === RPCID.SnapTo) {
                    const player = this.playerData.find(p => p.transformNetId === rpcPart.handlerid);
                    if (player) {
                        const pose = {
                            x: LerpValue(rpcPart.x / 65535, -40, 40),
                            y: LerpValue(rpcPart.y/ 65535, -40, 40)
                        };
                        this.emitPlayerPose(player.name, pose);
                    }
                }
            };

            const handleSpawnMessage = (spawnPart: SpawnMessage) => {
                if (spawnPart.spawnid === SpawnID.Player) {
                    const playerSpawn: PlayerSpawn = spawnPart as PlayerSpawn;
                    const controlReader = new BufferReader(playerSpawn.components[0].data);
                    controlReader.bool();

                    const player = this.playerData.find(p => p.controlNetId === playerSpawn.components[0].netid);
                    if (player) {
                        player.clientId = playerSpawn.ownerid;
                        player.playerId = controlReader.uint8();
                        player.transformNetId = playerSpawn.components[2].netid;
                    } else {
                        this.playerData.push({
                            name: "",
                            clientId: playerSpawn.ownerid,
                            playerId: controlReader.uint8(),
                            controlNetId: playerSpawn.components[0].netid,
                            transformNetId: playerSpawn.components[2].netid,
                        });
                    }
                    console.log("player spawned in");
                } else if (spawnPart.spawnid === SpawnID.ShipStatus ||
                            spawnPart.spawnid === SpawnID.HeadQuarters ||
                            spawnPart.spawnid === SpawnID.PlanetMap ||
                            spawnPart.spawnid === SpawnID.AprilShipStatus) {
                    this.shipStatusNetId = spawnPart.components[0].netid;
                }
            };

            await this.client.connect(servers[0], servers[1], "auprox");
            await this.client.join(this.backendModel.gameCode, {
                doSpawn: false
            });

            console.log(`Initialized PublicLobby Backend for game: ${this.backendModel.gameCode}`);
        } catch (err) {
            console.warn("Error in PublicLobbyBackend, disposing room: " + err);
            this.emit(BackendEvent.Error);
        }
    }

    async firstSpawn(servers: [string, number]): Promise<void> {
        this.playerData = [];
        this.shipStatusNetId = -1;

        const client = new AmongusClient({
            debug: DebugOptions.None
        });
        try {
            await client.connect(servers[0], servers[1], "auprox");
        } catch (e) {
            console.error("An error occurred", e);
            this.emitError("Couldn't connect to the Among Us servers, the server may be full, try again later!");
            return;
        }
        let game;
        try {
            game = client.join(this.backendModel.gameCode, {
                doSpawn: true
            });
        } catch (e) {
            console.error("Couldn't join game", e);
            this.emitError("Couldn't join the game, make sure that the game hasn't started and there is a spot for the client!");
            return;
        }
        await game.awaitSpawns();
        this.currentMap = game.options.mapID;
        this.emitMapChange(MapIdModel[MapID[game.options.mapID]]);
        game.clients.forEach(client => {
            if (client.name !== "") {
                this.playerData.push({
                    name: client.name,
                    clientId: client.id,
                    playerId: client.Player.PlayerControl.playerId,
                    controlNetId: client.Player.PlayerControl.netid,
                    transformNetId: client.Player.CustomNetworkTransform.netid
                });
            }
        });
        await this.client.disconnect();
    }

    async destroy(): Promise<void> {
        if (this.client && this.client.socket) {
            await this.client.disconnect();
            this.client = undefined;
        }
        console.log(`Destroyed PublicLobbyBackend for game: ${this.backendModel.gameCode}`);
    }
}

