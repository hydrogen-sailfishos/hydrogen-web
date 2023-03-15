/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import type {HomeServerApi} from "../../../net/HomeServerApi";
import type {DeviceTracker} from "../../../e2ee/DeviceTracker.js";
import type {ILogItem} from "../../../../logging/types";
import type {Clock} from "../../../../platform/web/dom/Clock.js";
import type {DeviceMessageHandler} from "../../../DeviceMessageHandler.js";
import {makeTxnId} from "../../../common.js";
import {CancelTypes, VerificationEventTypes} from "./types";
import {Disposables} from "../../../../utils/Disposables";
import {VerificationCancelledError} from "../VerificationCancelledError";

const messageFromErrorType = {
    [CancelTypes.UserCancelled]: "User declined",
    [CancelTypes.InvalidMessage]: "Invalid Message.",
    [CancelTypes.KeyMismatch]: "Key Mismatch.",
    [CancelTypes.OtherDeviceAccepted]: "Another device has accepted this request.",
    [CancelTypes.TimedOut]: "Timed Out",
    [CancelTypes.UnexpectedMessage]: "Unexpected Message.",
    [CancelTypes.UnknownMethod]: "Unknown method.",
    [CancelTypes.UnknownTransaction]: "Unknown Transaction.",
    [CancelTypes.UserMismatch]: "User Mismatch",
    [CancelTypes.MismatchedCommitment]: "Hash commitment does not match.",
    [CancelTypes.MismatchedSAS]: "Emoji/decimal does not match.",
}

export interface IChannel {
    send(eventType: string, content: any, log: ILogItem): Promise<void>;
    waitForEvent(eventType: string): Promise<any>;
    getSentMessage(event: VerificationEventTypes): any;
    getReceivedMessage(event: VerificationEventTypes): any;
    setStartMessage(content: any): void;
    setOurDeviceId(id: string): void;
    cancelVerification(cancellationType: CancelTypes): Promise<void>;
    acceptMessage: any;
    startMessage: any;
    initiatedByUs: boolean;
    id: string;
    otherUserDeviceId: string;
} 

type Options = {
    hsApi: HomeServerApi;
    deviceTracker: DeviceTracker;
    otherUserId: string;
    clock: Clock;
    deviceMessageHandler: DeviceMessageHandler;
    log: ILogItem;
}

export class ToDeviceChannel extends Disposables implements IChannel {
    private readonly hsApi: HomeServerApi;
    private readonly deviceTracker: DeviceTracker;
    private ourDeviceId: string;
    private readonly otherUserId: string;
    private readonly clock: Clock;
    private readonly deviceMessageHandler: DeviceMessageHandler;
    private readonly sentMessages: Map<VerificationEventTypes, any> = new Map();
    private readonly receivedMessages: Map<VerificationEventTypes, any> = new Map();
    private readonly waitMap: Map<string, {resolve: any, reject: any, promise: Promise<any>}> = new Map();
    private readonly log: ILogItem;
    public otherUserDeviceId: string;
    public startMessage: any;
    public id: string;
    private _initiatedByUs: boolean;
    private _isCancelled = false;

    /**
     * 
     * @param startingMessage Create the channel with existing message in the receivedMessage buffer
     */
    constructor(options: Options, startingMessage?: any) {
        super();
        this.hsApi = options.hsApi;
        this.deviceTracker = options.deviceTracker;
        this.otherUserId = options.otherUserId;
        this.clock = options.clock;
        this.log = options.log;
        this.deviceMessageHandler = options.deviceMessageHandler;
        this.track(
            this.deviceMessageHandler.disposableOn(
                "message",
                async ({ unencrypted }) =>
                    await this.handleDeviceMessage(unencrypted)
            )
        );
        this.track(() => {
            this.waitMap.forEach((value) => {
                value.reject(new VerificationCancelledError());
            });
        });
        // Copy over request message
        if (startingMessage) {
            /**
             * startingMessage may be the ready message or the start message.
             */
            this.id = startingMessage.content.transaction_id;
            this.receivedMessages.set(startingMessage.type, startingMessage);
            this.otherUserDeviceId = startingMessage.content.from_device;
        }
    }

    get isCancelled(): boolean {
        return this._isCancelled;
    }

    async send(eventType: VerificationEventTypes, content: any, log: ILogItem): Promise<void> {
        await log.wrap("ToDeviceChannel.send", async () => {
            if (this.isCancelled) {
                throw new VerificationCancelledError();
            }
            if (eventType === VerificationEventTypes.Request) {
                // Handle this case specially
                await this.handleRequestEventSpecially(eventType, content, log);
                return;
            }
            Object.assign(content, { transaction_id: this.id });
            const payload = {
                messages: {
                    [this.otherUserId]: {
                        [this.otherUserDeviceId]: content
                    }
                }
            }
            await this.hsApi.sendToDevice(eventType, payload, makeTxnId(), { log }).response();
            this.sentMessages.set(eventType, {content});
        });
    }

    private async handleRequestEventSpecially(eventType: VerificationEventTypes, content: any, log: ILogItem) {
        await log.wrap("ToDeviceChannel.handleRequestEventSpecially", async () => {
            const timestamp = this.clock.now();
            const txnId = makeTxnId();
            this.id = txnId;
            Object.assign(content, { timestamp, transaction_id: txnId });
            const payload = {
                messages: {
                    [this.otherUserId]: {
                        "*": content
                    }
                }
            }
            await this.hsApi.sendToDevice(eventType, payload, makeTxnId(), { log }).response();
            this.sentMessages.set(eventType, {content});
        });
    }

    getReceivedMessage(event: VerificationEventTypes) {
        return this.receivedMessages.get(event);
    }

    getSentMessage(event: VerificationEventTypes) {
        return this.sentMessages.get(event);
    }

    get acceptMessage(): any {
        return this.receivedMessages.get(VerificationEventTypes.Accept) ??
            this.sentMessages.get(VerificationEventTypes.Accept);
    }


    private async handleDeviceMessage(event) {
        await this.log.wrap("ToDeviceChannel.handleDeviceMessage", async (log) => {
            if (!event.type.startsWith("m.key.verification.")) {
                return;
            }
            if (event.content.transaction_id !== this.id) {
                /**
                 * When a device receives an unknown transaction_id, it should send an appropriate
                 * m.key.verification.cancel message to the other device indicating as such.
                 * This does not apply for inbound m.key.verification.start or m.key.verification.cancel messages.
                 */
                console.log("Received event with unknown transaction id: ", event);
                await this.cancelVerification(CancelTypes.UnknownTransaction);
                return;
            }
            console.log("event", event);
            log.log({ l: "event", event });
            this.resolveAnyWaits(event);
            this.receivedMessages.set(event.type, event);
            if (event.type === VerificationEventTypes.Ready) {
                this.handleReadyMessage(event, log);
                return;
            }
            if (event.type === VerificationEventTypes.Cancel) {
                this._isCancelled = true;
                this.dispose();
                return;
            }
        });
    }

    private async handleReadyMessage(event, log: ILogItem) {
        const fromDevice = event.content.from_device;
        this.otherUserDeviceId = fromDevice;
        // We need to send cancel messages to all other devices
        const devices = await this.deviceTracker.devicesForUsers([this.otherUserId], this.hsApi, log);
        const otherDevices = devices.filter(device => device.deviceId !== fromDevice && device.deviceId !== this.ourDeviceId);
        const cancelMessage = {
            code: CancelTypes.OtherDeviceAccepted,
            reason: messageFromErrorType[CancelTypes.OtherDeviceAccepted],
            transaction_id: this.id,
        };
        const deviceMessages = otherDevices.reduce((acc, device) => { acc[device.deviceId] = cancelMessage; return acc; }, {});
        const payload = {
            messages: {
                [this.otherUserId]: deviceMessages
            }
        }
        await this.hsApi.sendToDevice(VerificationEventTypes.Cancel, payload, makeTxnId(), { log }).response();
    }

    async cancelVerification(cancellationType: CancelTypes) {
        await this.log.wrap("Channel.cancelVerification", async log => {
            if (this.isCancelled) {
                throw new VerificationCancelledError();
            }
            const payload = {
                messages: {
                    [this.otherUserId]: {
                        [this.otherUserDeviceId]: {
                            code: cancellationType,
                            reason: messageFromErrorType[cancellationType],
                            transaction_id: this.id,
                        }
                    }
                }
            }
            await this.hsApi.sendToDevice(VerificationEventTypes.Cancel, payload, makeTxnId(), { log }).response();
            this._isCancelled = true;
            this.dispose();
        });
    }

    private resolveAnyWaits(event) {
        const { type } = event;
        const wait = this.waitMap.get(type);
        if (wait) {
            wait.resolve(event);
            this.waitMap.delete(type);
        }
    }

    waitForEvent(eventType: VerificationEventTypes): Promise<any> {
        if (this._isCancelled) {
            throw new VerificationCancelledError();
        }
        // Check if we already received the message
        const receivedMessage = this.receivedMessages.get(eventType);
        if (receivedMessage) {
            return Promise.resolve(receivedMessage);
        }
        // Check if we're already waiting for this message
        const existingWait = this.waitMap.get(eventType);
        if (existingWait) {
            return existingWait.promise;
        }
        let resolve, reject;
        // Add to wait map
        const promise = new Promise((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
        });
        this.waitMap.set(eventType, { resolve, reject, promise });
        return promise;
    }

    setOurDeviceId(id: string) {
        this.ourDeviceId = id;
    }

    setStartMessage(event) {
        this.startMessage = event;
        this._initiatedByUs = event.content.from_device === this.ourDeviceId;
    }

    get initiatedByUs(): boolean {
        return this._initiatedByUs;
    };
} 
