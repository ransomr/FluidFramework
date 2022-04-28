/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { SharedString, SharedStringFactory } from "@fluidframework/sequence";
import {
    MockContainerRuntimeFactory,
    MockFluidDataStoreRuntime,
    MockStorage,
} from "@fluidframework/test-runtime-utils";
import { SharedSegmentSequenceUndoRedoHandler } from "../sequenceHandler";
import { UndoRedoStackManager } from "../undoRedoStackManager";

const text =
    // eslint-disable-next-line max-len
    "The SharedSegementSequenceRevertible does the heavy lifting of tracking and reverting changes on the underlying SharedSegementSequence. This is accomplished via TrackingGroup objects.";

function insertTextAsChunks(sharedString: SharedString, targetLength = text.length) {
    let chunks = 0;
    while (sharedString.getLength() < targetLength && sharedString.getLength() < text.length) {
        const len = sharedString.getLength() % 13 + 1;
        sharedString.insertText(
            sharedString.getLength(),
            text.substr(sharedString.getLength(), len));
        chunks++;
    }
    return chunks;
}
function deleteTextByChunk(sharedString: SharedString, targetLength = 0) {
    let chunks = 0;
    while (sharedString.getLength() > targetLength && sharedString.getLength() > 0) {
        const len = sharedString.getLength() % 17 + 1;
        sharedString.removeText(
            Math.max(sharedString.getLength() - len, 0),
            sharedString.getLength());
        chunks++;
    }
    return chunks;
}

describe("SharedSegmentSequenceUndoRedoHandler", () => {
    const documentId = "fakeId";
    let containerRuntimeFactory: MockContainerRuntimeFactory;
    let sharedString: SharedString;
    let undoRedoStack: UndoRedoStackManager;

    beforeEach(() => {
        const dataStoreRuntime = new MockFluidDataStoreRuntime();

        containerRuntimeFactory = new MockContainerRuntimeFactory();
        const containerRuntime = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime);
        const services = {
            deltaConnection: containerRuntime.createDeltaConnection(),
            objectStorage: new MockStorage(undefined),
        };

        sharedString = new SharedString(dataStoreRuntime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        sharedString.bindToContext();
        sharedString.connect(services);

        undoRedoStack = new UndoRedoStackManager();
    });

    it("Undo and Redo Delete", () => {
        insertTextAsChunks(sharedString);
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);

        deleteTextByChunk(sharedString);

        assert.equal(sharedString.getText(), "");

        while (undoRedoStack.undoOperation()) { }

        assert.equal(sharedString.getText(), text);

        while (undoRedoStack.redoOperation()) { }

        assert.equal(sharedString.getText(), "");
    });

    it("Undo and Redo Insert", () => {
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);
        insertTextAsChunks(sharedString);

        assert.equal(sharedString.getText(), text);

        while (undoRedoStack.undoOperation()) { }

        assert.equal(sharedString.getText(), "");

        while (undoRedoStack.redoOperation()) { }

        assert.equal(sharedString.getText(), text);
    });

    it("Undo and Redo Insert & Delete", () => {
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);
        for (let i = 1; i < text.length; i *= 2) {
            insertTextAsChunks(sharedString, text.length - i);
            deleteTextByChunk(sharedString, i);
        }
        const finalText = sharedString.getText();

        assert.equal(sharedString.getText(), finalText);

        while (undoRedoStack.undoOperation()) { }

        assert.equal(sharedString.getText(), "");

        while (undoRedoStack.redoOperation()) { }

        assert.equal(sharedString.getText(), finalText, sharedString.getText());
    });

    it("Undo and redo insert of split segment", () => {
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);

        // insert all text as a single segment
        sharedString.insertText(0, text);

        containerRuntimeFactory.processAllMessages();

        // this will split that into three segment
        sharedString.walkSegments(
            () => true,
            20,
            30,
            undefined,
            true);

        assert.equal(sharedString.getText(), text);

        // undo and redo split insert
        undoRedoStack.undoOperation();
        undoRedoStack.redoOperation();

        assert.equal(sharedString.getText(), text);
    });

    it("Undo and Redo Delete - Bug Repro GH #8674", () => {
        const test = "ABC";
        sharedString.insertText(0, test);
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);

        sharedString.removeText(0, 1);
        assert.equal(sharedString.getText(), "BC");
        undoRedoStack.closeCurrentOperation();
        sharedString.removeText(0, 1);
        assert.equal(sharedString.getText(), "C");
        undoRedoStack.closeCurrentOperation();

        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "BC");
        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "ABC");
    });

    it("Undo and Redo Delete Reverse - Bug Repro GH #8674", () => {
        const test = "ABC";
        sharedString.insertText(0, test);
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);

        sharedString.removeText(1, 2);
        assert.equal(sharedString.getText(), "AC");
        undoRedoStack.closeCurrentOperation();
        sharedString.removeText(0, 1);
        assert.equal(sharedString.getText(), "C");
        undoRedoStack.closeCurrentOperation();

        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "AC");
        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "ABC");
    });

    it.only("Undo and Redo Delete Complex - Bug Repro GH #8674", () => {
        const test = "ABCD";
        sharedString.insertText(0, test);
        const handler = new SharedSegmentSequenceUndoRedoHandler(undoRedoStack);
        handler.attachSequence(sharedString);

        sharedString.removeText(0, 1);
        assert.equal(sharedString.getText(), "BCD");
        undoRedoStack.closeCurrentOperation();
        sharedString.removeText(0, 1);
        assert.equal(sharedString.getText(), "CD");
        undoRedoStack.closeCurrentOperation();
        sharedString.removeText(0, 1);
        assert.equal(sharedString.getText(), "D");
        undoRedoStack.closeCurrentOperation();

        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "CD");
        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "BCD");
        undoRedoStack.undoOperation();
        assert.equal(sharedString.getText(), "ABCD");
    });
});
