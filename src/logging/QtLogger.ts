/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import {BaseLogger} from "./BaseLogger";
import {LogItem} from "./LogItem";
import type {ILogItem, LogItemValues, ILogExport} from "./types";

export class QtLogger extends BaseLogger {
    _persistItem(item: LogItem): void {
        printToConsole(item);
    }

    async export(): Promise<ILogExport | undefined> {
        return undefined;
    }
}

const excludedKeysFromTable = ["l", "id"];

function filterValues(values: LogItemValues): LogItemValues | null {
    return Object.entries(values)
        .filter(([key]) => !excludedKeysFromTable.includes(key))
        .reduce((obj: LogItemValues, [key, value]) => {
            obj = obj || {};
            obj[key] = value;
            return obj;
        }, null);
}

function printToConsole(item: LogItem): void {
    const label = `${itemCaption(item)} (${item.duration}ms)`;

    if (item.error) {
        send(item.error);
    } else {
        send(label);
    }

}

function send(item) {
    var customEvent = new CustomEvent("framescript:log",
        {detail: {log: JSON.stringify(item)}});
    document.dispatchEvent(customEvent);
}

function itemCaption(item: ILogItem): string {
    if (item.values.t === "network") {
        return `${item.values.method} ${item.values.url}`;
    } else if (item.values.l && typeof item.values.id !== "undefined") {
        return `${item.values.l} ${item.values.id}`;
    } else if (item.values.l && typeof item.values.status !== "undefined") {
        return `${item.values.l} (${item.values.status})`;
    } else if (item.values.l && item.error) {
        return `${item.values.l} failed`;
    } else if (typeof item.values.ref !== "undefined") {
        return `ref ${item.values.ref}`;
    } else {
        return item.values.l || item.values.type;
    }
}
