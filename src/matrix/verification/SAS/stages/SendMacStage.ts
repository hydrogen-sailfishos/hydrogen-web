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
import {BaseSASVerificationStage} from "./BaseSASVerificationStage";
import {ILogItem} from "../../../../logging/types";
import {VerificationEventTypes} from "../channel/types";
import {createCalculateMAC} from "../mac";
import {VerifyMacStage} from "./VerifyMacStage";

export class SendMacStage extends BaseSASVerificationStage {
    async completeStage() {
        await this.log.wrap("SendMacStage.completeStage", async (log) => {
            const acceptMessage = this.channel.acceptMessage.content;
            const macMethod = acceptMessage.message_authentication_code;
            const calculateMAC = createCalculateMAC(this.olmSAS, macMethod);
            await this.sendMAC(calculateMAC, log);
            await this.channel.waitForEvent(VerificationEventTypes.Mac);
            this.setNextStage(new VerifyMacStage(this.options));
        });
    }

    private async sendMAC(calculateMAC: (input: string, info: string) => string, log: ILogItem): Promise<void> {
        const mac: Record<string, string> = {};
        const keyList: string[] = [];
        const baseInfo =
            "MATRIX_KEY_VERIFICATION_MAC" +
            this.ourUserId +
            this.ourUserDeviceId +
            this.otherUserId +
            this.otherUserDeviceId +
            this.channel.id;

        const deviceKeyId = `ed25519:${this.ourUserDeviceId}`;
        const deviceKeys = this.e2eeAccount.getDeviceKeysToSignWithCrossSigning();
        mac[deviceKeyId] = calculateMAC(deviceKeys.keys[deviceKeyId], baseInfo + deviceKeyId);
        keyList.push(deviceKeyId);

        const {masterKey: crossSigningKey} = await this.deviceTracker.getCrossSigningKeysForUser(this.ourUserId, this.hsApi, log);
        if (crossSigningKey) {
            const crossSigningKeyId = `ed25519:${crossSigningKey}`;
            mac[crossSigningKeyId] = calculateMAC(crossSigningKey, baseInfo + crossSigningKeyId);
            keyList.push(crossSigningKeyId);
        }

        const keys = calculateMAC(keyList.sort().join(","), baseInfo + "KEY_IDS");
        await this.channel.send(VerificationEventTypes.Mac, { mac, keys }, log);
    }
}

