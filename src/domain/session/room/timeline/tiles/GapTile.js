/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

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

import {SimpleTile} from "./SimpleTile.js";
import {UpdateAction} from "../UpdateAction.js";

export class GapTile extends SimpleTile {
    constructor(options) {
        super(options);
        this._loading = false;
        this._error = null;
        this._isAtTop = true;
        this._siblingChanged = false;
    }

    async fill() {
        if (!this._loading && !this._entry.edgeReached) {
            this._loading = true;
            this.emitChange("isLoading");
            try {
                await this._room.fillGap(this._entry, 10);
            } catch (err) {
                console.error(`room.fillGap(): ${err.message}:\n${err.stack}`);
                this._error = err;
                this.emitChange("error");
                // rethrow so caller of this method
                // knows not to keep calling this for now
                throw err;
            } finally {
                this._loading = false;
                this.emitChange("isLoading");
            }
                return true;
        }
        return false;
    }

    async notifyVisible() {
        // we do (up to 10) backfills while no new tiles have been added to the timeline
        // because notifyVisible won't be called again until something gets added to the timeline
        let depth = 0;
        let canFillMore;
        this._siblingChanged = false;
        do {
            canFillMore = await this.fill();
            depth = depth + 1;
        } while (depth < 10 && !this._siblingChanged && canFillMore && !this.isDisposed);
    }

    get isAtTop() {
        return this._isAtTop;
    }

    updatePreviousSibling(prev) {
        super.updatePreviousSibling(prev);
        const isAtTop = !prev;
        if (this._isAtTop !== isAtTop) {
            this._isAtTop = isAtTop;
            this.emitChange("isAtTop");
        }
        this._siblingChanged = true;
    }

    updateNextSibling() {
        // if the sibling of the gap changed while calling room.fill(),
        // we intepret this as at least one new tile has been added to
        // the timeline. See notifyVisible why this is important.
        this._siblingChanged = true;
    }

    updateEntry(entry, params, tilesCreator) {
        super.updateEntry(entry, params, tilesCreator);
        if (!entry.isGap) {
            return UpdateAction.Remove();
        } else {
            return UpdateAction.Nothing();
        }
    }

    get shape() {
        return "gap";
    }

    get isLoading() {
        return this._loading;
    }

    get error() {
        if (this._error) {
            const dir = this._entry.prev_batch ? "previous" : "next";
            return `Could not load ${dir} messages: ${this._error.message}`;
        }
        return null;
    }
}

import {FragmentBoundaryEntry} from "../../../../../matrix/room/timeline/entries/FragmentBoundaryEntry.js";
export function tests() {
    return {
        "uses updated token to fill": async assert => {
            let currentToken = 5;
            const fragment = {
                id: 0,
                previousToken: currentToken,
                roomId: "!abc"
            };
            const room = {
                async fillGap(entry) {
                    assert.equal(entry.token, currentToken);
                    currentToken += 1;
                    const newEntry = entry.withUpdatedFragment(Object.assign({}, fragment, {previousToken: currentToken}));
                    tile.updateEntry(newEntry);
                }
            };
            const tile = new GapTile({entry: new FragmentBoundaryEntry(fragment, true), roomVM: {room}});
            await tile.fill();
            await tile.fill();
            await tile.fill();
            assert.equal(currentToken, 8);
        }
    }
}
