import * as runtime from "@prague/container-definitions";
import { EventEmitter } from "events";

export interface IConnectionDetails {
    clientId: string;
    existing: boolean;
    parentBranch: string;
    initialMessages?: runtime.ISequencedDocumentMessage[];
    initialContents?: runtime.IContentMessage[];
    maxMessageSize: number;
}

export class DeltaConnection extends EventEmitter {
    public static async Connect(
        tenantId: string,
        id: string,
        tokenProvider: runtime.ITokenProvider,
        service: runtime.IDocumentService,
        client: runtime.IClient) {
        const connection = await service.connectToDeltaStream(tenantId, id, tokenProvider, client);
        return new DeltaConnection(connection);
    }

    public get details(): IConnectionDetails {
        return this._details;
    }

    public get nacked(): boolean {
        return this._nacked;
    }

    public get connected(): boolean {
        return this._connected;
    }

    // tslint:disable:variable-name
    private _details: IConnectionDetails;
    private _nacked = false;
    private _connected = true;
    // tslint:enable:variable-name

    private constructor(private connection: runtime.IDocumentDeltaConnection) {
        super();

        this._details = {
            clientId: connection.clientId,
            existing: connection.existing,
            initialContents: connection.initialContents,
            initialMessages: connection.initialMessages,
            maxMessageSize: connection.maxMessageSize,
            parentBranch: connection.parentBranch,
        };

        // listen for new messages
        connection.on("op", (documentId: string, messages: runtime.ISequencedDocumentMessage[]) => {
            this.emit("op", documentId, messages);
        });

        connection.on("op-content", (message: runtime.IContentMessage) => {
            this.emit("op-content", message);
        });

        connection.on("nack", (documentId: string, message: runtime.INack[]) => {
            // Mark nacked and also pause any outbound communication
            this._nacked = true;
            const target = message[0].sequenceNumber;
            this.emit("nack", target);
        });

        connection.on("disconnect", (reason) => {
            this._connected = false;
            this.emit("disconnect", reason);
        });

        // Listen for socket.io latency messages
        connection.on("pong", (latency: number) => {
            this.emit("pong", latency);
        });
    }

    /**
     * Closes the delta connection. This disconnects the socket and clears any listeners
     */
    public close() {
        this._connected = false;
        this.connection.disconnect();
        this.removeAllListeners();
    }

    public submit(message: runtime.IDocumentMessage): void {
        this.connection.submit(message);
    }

    public async submitAsync(message: runtime.IDocumentMessage): Promise<void> {
        return this.connection.submitAsync(message);
    }
}
