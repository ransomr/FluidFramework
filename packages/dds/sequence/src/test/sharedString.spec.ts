/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { ISummaryTree } from "@fluidframework/protocol-definitions";
import { IChannelServices } from "@fluidframework/datastore-definitions";
import {
    Marker,
    ReferenceType,
    reservedMarkerIdKey,
    reservedMarkerSimpleTypeKey,
    reservedTileLabelsKey,
} from "@fluidframework/merge-tree";
import {
    MockFluidDataStoreRuntime,
    MockContainerRuntimeFactory,
    MockContainerRuntimeFactoryForReconnection,
    MockContainerRuntimeForReconnection,
    MockEmptyDeltaConnection,
    MockStorage,
} from "@fluidframework/test-runtime-utils";
import { SharedString } from "../sharedString";
import { SharedStringFactory } from "../sequenceFactory";
import { IntervalCollection, IntervalType, SequenceInterval } from "../intervalCollection";

const assertIntervals = (
    sharedString: SharedString,
    intervalCollection: IntervalCollection<SequenceInterval>,
    expected: readonly { start: number; end: number; }[],
) => {
    const actual = intervalCollection.findOverlappingIntervals(0, sharedString.getLength() - 1);
    assert.strictEqual(actual.length, expected.length,
        `findOverlappingIntervals() must return the expected number of intervals`);

    for (const actualInterval of actual) {
        const start = sharedString.localRefToPos(actualInterval.start);
        const end = sharedString.localRefToPos(actualInterval.end);
        let found = false;

        // console.log(`[${start},${end}): ${sharedString.getText().slice(start, end)}`);

        for (const expectedInterval of expected) {
            if (expectedInterval.start === start && expectedInterval.end === end) {
                found = true;
                break;
            }
        }

        assert(found, `Unexpected interval [${start}..${end}) (expected ${JSON.stringify(expected)})`);
    }
};

describe("SharedString", () => {
    let sharedString: SharedString;
    let dataStoreRuntime1: MockFluidDataStoreRuntime;

    beforeEach(() => {
        dataStoreRuntime1 = new MockFluidDataStoreRuntime();
        sharedString = new SharedString(dataStoreRuntime1, "shared-string-1", SharedStringFactory.Attributes);
    });

    describe("SharedString in local state", () => {
        beforeEach(() => {
            dataStoreRuntime1.local = true;
        });

        // Creates a new SharedString and loads it from the passed snaphost tree.
        async function CreateStringAndCompare(summaryTree: ISummaryTree): Promise<void> {
            const services: IChannelServices = {
                deltaConnection: new MockEmptyDeltaConnection(),
                objectStorage: MockStorage.createFromSummary(summaryTree),
            };
            const dataStoreRuntime2 = new MockFluidDataStoreRuntime();
            const sharedString2 = new SharedString(
                dataStoreRuntime2,
                "shared-string-2",
                SharedStringFactory.Attributes);
            await sharedString2.load(services);
            await sharedString2.loaded;

            assert.equal(sharedString.getText(), sharedString2.getText(), "Could not correctly load from snapshot");
        }

        function verifyAndReturnSummaryTree(): ISummaryTree {
            const summarizeResult = sharedString.getAttachSummary();
            const summaryObjectKeys = Object.keys(summarizeResult.summary.tree);
            assert.strictEqual(summaryObjectKeys.length, 1, "summary should have one entries");
            assert.strictEqual(summaryObjectKeys[0], "content", "content not present in summary");

            const subTree = summarizeResult.summary.tree.content as ISummaryTree;
            const subTreeObjectKeys = Object.keys(subTree.tree);
            assert.strictEqual(subTreeObjectKeys.length, 1, "sub tree should have one entries");
            assert.strictEqual(subTreeObjectKeys[0], "header", "header not present in sub tree");

            return summarizeResult.summary;
        }

        it("can insert text", async () => {
            sharedString.insertText(0, "hello");
            assert.equal(sharedString.getText(), "hello", "Could not insert text at beginning");

            sharedString.insertText(5, "world");
            assert.equal(sharedString.getText(), "helloworld", "Could not insert text at end");

            sharedString.insertText(5, " ");
            assert.equal(sharedString.getText(), "hello world", "Could not insert text in the middle");
        });

        it("can replace text", async () => {
            sharedString.insertText(0, "hello world");

            sharedString.replaceText(6, 11, "there!");
            assert.equal(sharedString.getText(), "hello there!", "Could not replace text");

            sharedString.replaceText(0, 5, "hi");
            assert.equal(sharedString.getText(), "hi there!", "Could not replace text at beginning");
        });

        it("can remove text", async () => {
            sharedString.insertText(0, "hello world");

            sharedString.removeText(5, 11);
            assert.equal(sharedString.getText(), "hello", "Could not remove text");

            sharedString.removeText(0, 3);
            assert.equal(sharedString.getText(), "lo", "Could not remove text from beginning");
        });

        it("can annotate the text", async () => {
            const text = "hello world";
            const styleProps = { style: "bold" };
            sharedString.insertText(0, text, styleProps);

            for (let i = 0; i < text.length; i++) {
                assert.deepEqual(
                    { ...sharedString.getPropertiesAtPosition(i) }, { ...styleProps }, "Could not add props");
            }

            const colorProps = { color: "green" };
            sharedString.annotateRange(6, text.length, colorProps);

            for (let i = 6; i < text.length; i++) {
                assert.deepEqual(
                    { ...sharedString.getPropertiesAtPosition(i) },
                    { ...styleProps, ...colorProps },
                    "Could not annotate props");
            }
        });

        it("can handle null annotations in text", async () => {
            const text = "hello world";
            const startingProps = { style: "bold", color: null };
            sharedString.insertText(0, text, startingProps);

            for (let i = 0; i < text.length; i++) {
                assert.strictEqual(
                    sharedString.getPropertiesAtPosition(i).color, undefined, "Null values allowed in properties");
            }
            const updatedProps = { style: null };
            sharedString.annotateRange(6, text.length, updatedProps);

            for (let i = 6; i < text.length; i++) {
                assert.strictEqual(
                    sharedString.getPropertiesAtPosition(i).style,
                    undefined,
                    "Null values allowed in properties");
            }
        });

        it("can insert marker", () => {
            sharedString.insertText(0, "hello world");
            // Insert a simple marker.
            sharedString.insertMarker(
                6,
                ReferenceType.Simple,
                {
                    [reservedMarkerIdKey]: "markerId",
                    [reservedMarkerSimpleTypeKey]: "markerKeyValue",
                },
            );

            // Verify that the simple marker can be retrieved via id.
            const simpleMarker = sharedString.getMarkerFromId("markerId");
            assert.equal(simpleMarker.type, "Marker", "Could not get simple marker");
            assert.equal(simpleMarker.properties.markerId, "markerId", "markerId is incorrect");
            assert.equal(simpleMarker.properties.markerSimpleType, "markerKeyValue", "markerSimpleType is incorrrect");

            // Insert a tile marker.
            sharedString.insertMarker(
                0,
                ReferenceType.Tile,
                {
                    [reservedTileLabelsKey]: ["tileLabel"],
                    [reservedMarkerIdKey]: "tileMarkerId",
                });

            // Verify that the tile marker can be retrieved via label.
            const { parallelMarkers } = sharedString.getTextAndMarkers("tileLabel");
            const parallelMarker = parallelMarkers[0];
            assert.equal(parallelMarker.type, "Marker", "Could not get tile marker");
            assert.equal(parallelMarker.properties.markerId, "tileMarkerId", "tile markerId is incorrect");
        });

        it("can annotate marker", () => {
            sharedString.insertText(0, "hello world");
            // Insert a simple marker.
            sharedString.insertMarker(
                6,
                ReferenceType.Simple,
                {
                    [reservedMarkerIdKey]: "markerId",
                },
            );

            // Annotate the marker.
            const props = { color: "blue" };
            const simpleMarker = sharedString.getMarkerFromId("markerId") as Marker;
            sharedString.annotateMarker(simpleMarker, props);
            assert.equal(simpleMarker.properties.color, "blue", "Could not annotate marker");
        });

        it("replace zero range", async () => {
            sharedString.insertText(0, "123");
            sharedString.replaceText(1, 1, "\u00e4\u00c4");
            assert.equal(sharedString.getText(), "1\u00e4\u00c423", "Could not replace zero range");
        });

        it("replace negative range", async () => {
            sharedString.insertText(0, "123");
            sharedString.replaceText(2, 1, "aaa");
            // This assert relies on the behavior that replacement for a reversed range
            // will insert at the max end of the range but not delete the range
            assert.equal(sharedString.getText(), "12aaa3", "Could not replace negative range");
        });

        it("can load a SharedString from summary", async () => {
            const insertText = "text";
            const segmentCount = 1000;

            sharedString.initializeLocal();

            for (let i = 0; i < segmentCount; i = i + 1) {
                sharedString.insertText(0, `${insertText}${i}`);
            }

            // Verify that summary data is correcy.
            let summaryTree = verifyAndReturnSummaryTree();

            // Load a new SharedString from the snapshot and verify it is loaded correctly.
            await CreateStringAndCompare(summaryTree);

            for (let i = 0; i < segmentCount; i = i + 1) {
                sharedString.insertText(0, `${insertText}-${i}`);
            }

            // TODO: Due to segment packing, we have only "header" and no body
            // Need to change test to include other types of segments (like marker) to exercise "body".

            // Verify summary after changes.
            summaryTree = verifyAndReturnSummaryTree();

            // Load a new SharedString from the snapshot and verify it is loaded correctly.
            await CreateStringAndCompare(summaryTree);
        });
    });

    describe("SharedString op processing in local state", () => {
        it("should correctly process operations sent in local state", async () => {
            // Set the data store runtime to local.
            dataStoreRuntime1.local = true;

            // Initialize the shared string so that it is completely loaded before we take a snapshot.
            sharedString.initializeLocal();

            // Insert and replace text in first shared string.
            sharedString.insertText(0, "hello world");
            sharedString.replaceText(6, 11, "there");

            // Load a new Ink in connected state from the snapshot of the first one.
            const containerRuntimeFactory = new MockContainerRuntimeFactory();
            const dataStoreRuntime2 = new MockFluidDataStoreRuntime();
            const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime2);
            const services2: IChannelServices = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: MockStorage.createFromSummary(sharedString.getAttachSummary().summary),
            };

            const sharedString2 =
                new SharedString(dataStoreRuntime2, "shared-string-2", SharedStringFactory.Attributes);
            await sharedString2.load(services2);

            // Now connect the first Ink
            dataStoreRuntime1.local = false;
            const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1 = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(undefined),
            };
            sharedString.connect(services1);

            // Verify that both the shared strings have the text.
            assert.equal(sharedString.getText(), "hello there", "The first string does not have the text");
            assert.equal(sharedString2.getText(), "hello there", "The second string does not have the text");

            // Insert and replace text in second shared string.
            sharedString2.insertText(0, "well ");

            // Process the message.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings have the new text.
            assert.equal(sharedString.getText(), "well hello there", "The first string does not have the text");
            assert.equal(sharedString2.getText(), "well hello there", "The second string does not have the text");
        });
    });

    describe("SharedString in connected state with a remote SharedString", () => {
        let sharedString2: SharedString;
        let containerRuntimeFactory: MockContainerRuntimeFactory;

        beforeEach(() => {
            containerRuntimeFactory = new MockContainerRuntimeFactory();

            // Connect the first SharedString.
            dataStoreRuntime1.local = false;
            const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1 = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString.initializeLocal();
            sharedString.connect(services1);

            // Create and connect a second SharedString.
            const dataStoreRuntime2 = new MockFluidDataStoreRuntime();
            const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime2);
            const services2 = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };

            sharedString2 = new SharedString(dataStoreRuntime2, "shared-string-2", SharedStringFactory.Attributes);
            sharedString2.initializeLocal();
            sharedString2.connect(services2);
        });

        it("can maintain interval consistency", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "xyz");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");
            assert.notStrictEqual(collection2, undefined, "undefined");
            assert.strictEqual(sharedString.getText(), sharedString2.getText(), "not equal text");

            sharedString.insertText(0, "abc");
            const interval = collection1.add(1, 1, IntervalType.SlideOnRemove);
            const intervalId = interval.getIntervalId();
            sharedString2.insertText(0, "wha");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "whaabcxyz", "different text 1");
            assert.strictEqual(sharedString.getText(), "whaabcxyz", "different text 2");

            assertIntervals(sharedString, collection1, [
                { start: 4, end: 4 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 4, end: 4 },
            ]);

            collection2.change(intervalId, 1, 6);
            sharedString.removeText(0, 2);
            collection1.change(intervalId, 0, 5);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 0, end: 5 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 0, end: 5 },
            ]);

            collection1.change(intervalId, sharedString.getLength() - 1, sharedString.getLength() - 1);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: sharedString.getLength() - 1, end: sharedString.getLength() - 1 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: sharedString2.getLength() - 1, end: sharedString2.getLength() - 1 },
            ]);
        });

        it("can slide intervals on remove ack", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection1.add(1, 3, IntervalType.SlideOnRemove);
            containerRuntimeFactory.processAllMessages();

            sharedString.insertText(2, "X");
            assert.strictEqual(sharedString.getText(), "ABXCD");
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 4 },
            ]);

            sharedString2.removeRange(1, 2);
            assert.strictEqual(sharedString2.getText(), "ACD");
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 2 },
            ]);

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");

            assertIntervals(sharedString, collection1, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 3 },
            ]);
        });

        // TODO:ransomr enable test once sliding in markRangeRemoved is fixed
        it.skip("can slide intervals to segment not referenced by remove", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString.insertText(2, "X");
            assert.strictEqual(sharedString.getText(), "ABXCD");
            collection1.add(1, 3, IntervalType.SlideOnRemove);

            sharedString2.removeRange(1, 2);
            assert.strictEqual(sharedString2.getText(), "ACD");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 2 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 2 },
            ]);
        });

        // TODO:ransomr test breaks until we fix remove to not slide un-acked positions
        it.skip("can slide intervals on create ack", () => {
            // Create and connect a third SharedString.
            const dataStoreRuntime3 = new MockFluidDataStoreRuntime();
            const containerRuntime3 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime3);
            const services3 = {
                deltaConnection: containerRuntime3.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };

            const sharedString3 = new SharedString(
                dataStoreRuntime3, "shared-string-3", SharedStringFactory.Attributes);
            sharedString3.initializeLocal();
            sharedString3.connect(services3);

            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");
            const collection3 = sharedString3.getIntervalCollection("test");

            sharedString.removeRange(1, 2);
            assert.strictEqual(sharedString.getText(), "ACD");

            sharedString2.insertText(2, "X");
            assert.strictEqual(sharedString2.getText(), "ABXCD");

            collection3.add(1, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");
            assert.strictEqual(sharedString3.getText(), "AXCD");

            assertIntervals(sharedString, collection1, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString3, collection3, [
                { start: 1, end: 3 },
            ]);
        });

        it("can slide intervals on create before remove", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection2.add(1, 3, IntervalType.SlideOnRemove);

            sharedString.removeRange(1, 3);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);
        });

        it("can slide intervals on remove before create", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCDE");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString.removeRange(1, 3);
            assert.strictEqual(sharedString.getText(), "ADE");

            collection2.add(1, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            // before fixing this, at this point the start range on sharedString
            // is on the removed segment. Can't detect that from the interval API.
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);

            // More operations reveal the problem
            sharedString.insertText(2, "X");
            assert.strictEqual(sharedString.getText(), "ADXE");
            sharedString2.removeRange(1, 2);
            assert.strictEqual(sharedString2.getText(), "AE");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXE");

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);
        });

        it("can maintain consistency of LocalReference's when segments are packed", async () => {
            // sharedString.insertMarker(0, ReferenceType.Tile, { nodeType: "Paragraph" });

            const collection1 = sharedString.getIntervalCollection("test2");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test2");

            sharedString.insertText(0, "a");
            sharedString.insertText(1, "b");
            sharedString.insertText(2, "c");
            sharedString.insertText(3, "d");
            sharedString.insertText(4, "e");
            sharedString.insertText(5, "f");

            containerRuntimeFactory.processAllMessages();

            assert.strictEqual(sharedString.getText(), "abcdef", "incorrect text 1");
            assert.strictEqual(sharedString2.getText(), "abcdef", "incorrect text 2");

            collection1.add(2, 2, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
            ]);

            sharedString.insertText(0, "a");
            sharedString.insertText(1, "b");
            sharedString.insertText(2, "c");
            sharedString.insertText(3, "d");
            sharedString.insertText(4, "e");
            sharedString.insertText(5, "f");

            containerRuntimeFactory.processAllMessages();

            assert.strictEqual(sharedString.getText(), "abcdefabcdef", "incorrect text 2");
            assert.strictEqual(sharedString2.getText(), "abcdefabcdef", "incorrect text 3");

            collection1.add(5, 5, IntervalType.SlideOnRemove);
            collection1.add(2, 2, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);

            // Summarize to cause Zamboni to pack segments. Confirm consistency after packing.
            await sharedString2.summarize();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
        });

        it("can insert text", async () => {
            // Insert text in first shared string.
            sharedString.insertText(0, "hello");

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings inserted the text.
            assert.equal(sharedString.getText(), "hello", "Could not insert text at beginning");
            assert.equal(sharedString2.getText(), "hello", "Could not insert text at beginning in remote string");

            // Insert text at the end of second shared string.
            sharedString2.insertText(5, " world");

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings inserted the text.
            assert.equal(sharedString.getText(), "hello world", "Could not insert text at end");
            assert.equal(sharedString2.getText(), "hello world", "Could not insert text at end in remote string");
        });

        it("can replace text", async () => {
            // Insert and replace text in first shared string.
            sharedString.insertText(0, "hello world");
            sharedString.replaceText(6, 11, "there!");

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings replaced the text.
            assert.equal(sharedString.getText(), "hello there!", "Could not replace text");
            assert.equal(sharedString2.getText(), "hello there!", "Could not replace text in remote string");
        });

        it("can remove text", async () => {
            // Insert and remove text in first shared string.
            sharedString.insertText(0, "hello world");
            sharedString.removeText(5, 11);

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings removed the text.
            assert.equal(sharedString.getText(), "hello", "Could not remove text");
            assert.equal(sharedString2.getText(), "hello", "Could not remove text from remote string");
        });

        it("can annotate the text", async () => {
            // Insert text with properties in the first shared string.
            const text = "hello world";
            const styleProps = { style: "bold" };
            sharedString.insertText(0, text, styleProps);

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings have the properties.
            for (let i = 0; i < text.length; i++) {
                assert.deepEqual(
                    { ...sharedString.getPropertiesAtPosition(i) },
                    { ...styleProps },
                    "Could not add props");
                assert.deepEqual(
                    { ...sharedString2.getPropertiesAtPosition(i) },
                    { ...styleProps },
                    "Could not add props to remote string");
            }

            // Annote the properties.
            const colorProps = { color: "green" };
            sharedString.annotateRange(6, text.length, colorProps);

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that both the shared strings have the annotated properties.
            for (let i = 6; i < text.length; i++) {
                assert.deepEqual(
                    { ...sharedString.getPropertiesAtPosition(i) },
                    { ...styleProps, ...colorProps },
                    "Could not annotate props");
                assert.deepEqual(
                    { ...sharedString2.getPropertiesAtPosition(i) },
                    { ...styleProps, ...colorProps },
                    "Could not annotate props in remote string");
            }
        });

        it("can insert marker", () => {
            const label = "tileLabel";
            const id = "tileMarkerId";
            const simpleKey = "tileMarkerKey";

            const verifyMarker = (marker) => {
                assert.equal(marker.type, "Marker", "Could not get simple marker");
                assert.equal(marker.properties.markerId, id, "markerId is incorrect");
                assert.equal(marker.properties.markerSimpleType, simpleKey, "markerSimpleType is incorrrect");
                assert.equal(marker.properties.referenceTileLabels[0], label, "markerSimpleType is incorrrect");
            };

            sharedString.insertText(0, "hello world");

            // Insert a tile marker.
            sharedString.insertMarker(
                6,
                ReferenceType.Tile,
                {
                    [reservedTileLabelsKey]: [label],
                    [reservedMarkerIdKey]: id,
                    [reservedMarkerSimpleTypeKey]: simpleKey,
                },
            );

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that the marker can be retrieved via id from both the shared strings.
            const simpleMarker1 = sharedString.getMarkerFromId(id);
            verifyMarker(simpleMarker1);
            const simpleMarker2 = sharedString2.getMarkerFromId(id);
            verifyMarker(simpleMarker2);

            // Verify that the marker can be retrieved via label from both the shared strings.
            const textAndMarker1 = sharedString.getTextAndMarkers(label);
            verifyMarker(textAndMarker1.parallelMarkers[0]);
            const textAndMarker2 = sharedString2.getTextAndMarkers(label);
            verifyMarker(textAndMarker2.parallelMarkers[0]);
        });

        it("can annotate marker", () => {
            sharedString.insertText(0, "hello world");
            // Insert a simple marker.
            sharedString.insertMarker(
                6,
                ReferenceType.Simple,
                {
                    [reservedMarkerIdKey]: "markerId",
                },
            );

            // Annotate the marker.
            const props = { color: "blue" };
            const simpleMarker = sharedString.getMarkerFromId("markerId") as Marker;
            sharedString.annotateMarker(simpleMarker, props);

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that the marker was annotated in both the shared strings.
            const simpleMarker1 = sharedString.getMarkerFromId("markerId") as Marker;
            assert.equal(simpleMarker1.properties.color, "blue", "Could not annotate marker");

            const simpleMarker2 = sharedString.getMarkerFromId("markerId") as Marker;
            assert.equal(simpleMarker2.properties.color, "blue", "Could not annotate marker in remote string");
        });

        it("test IntervalCollection creation events", () => {
            let createCalls1 = 0;
            const createInfo1 = [];
            const createCallback1 = (label: string, local: boolean, target: SharedString) => {
                assert.strictEqual(target, sharedString, "Expected event to target sharedString");
                createInfo1[createCalls1++] = { local, label };
            };
            sharedString.on("createIntervalCollection", createCallback1);

            let createCalls2 = 0;
            const createInfo2 = [];
            const createCallback2 = (label: string, local: boolean, target: SharedString) => {
                assert.strictEqual(target, sharedString2, "Expected event to target sharedString2");
                createInfo2[createCalls2++] = { local, label };
            };
            sharedString2.on("createIntervalCollection", createCallback2);

            sharedString.insertText(0, "hello world");
            containerRuntimeFactory.processAllMessages();

            const collection1: IntervalCollection<SequenceInterval> = sharedString.getIntervalCollection("test1");
            const interval1 = collection1.add(0, 1, IntervalType.SlideOnRemove);
            collection1.change(interval1.getIntervalId(), 1, 4);

            const collection2: IntervalCollection<SequenceInterval> = sharedString2.getIntervalCollection("test2");
            const interval2 = collection2.add(0, 2, IntervalType.SlideOnRemove);
            collection2.removeIntervalById(interval2.getIntervalId());

            const collection3: IntervalCollection<SequenceInterval> = sharedString2.getIntervalCollection("test3");
            collection3.add(0, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            const verifyCreateEvents = (s: SharedString, createInfo, infoArray) => {
                let i = 0;
                const labels = s.getIntervalCollectionLabels();
                for (const label of labels) {
                    assert.equal(label, infoArray[i].label, `Bad label ${i}: ${label}`);
                    assert.equal(label, createInfo[i].label, `Bad label ${i}: ${createInfo[i].label}`);
                    assert.equal(
                        createInfo[i].local, infoArray[i].local, `Bad local value ${i}: ${createInfo[i].local}`);
                    i++;
                }
                assert.equal(infoArray.length, createInfo.length, `Wrong number of create calls: ${i}`);
            };
            verifyCreateEvents(sharedString, createInfo1, [
                { label: "intervalCollections/test1", local: true },
                { label: "intervalCollections/test2", local: false },
                { label: "intervalCollections/test3", local: false },
            ]);
            verifyCreateEvents(sharedString2, createInfo2, [
                { label: "intervalCollections/test2", local: true },
                { label: "intervalCollections/test3", local: true },
                { label: "intervalCollections/test1", local: false },
            ]);
        });
    });

    describe("reconnect", () => {
        let containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection;
        let containerRuntime1: MockContainerRuntimeForReconnection;
        let containerRuntime2: MockContainerRuntimeForReconnection;
        let sharedString2: SharedString;

        beforeEach(async () => {
            containerRuntimeFactory = new MockContainerRuntimeFactoryForReconnection();

            // Connect the first SharedString.
            containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1: IChannelServices = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString.initializeLocal();
            sharedString.connect(services1);

            // Create and connect a second SharedString.
            const runtime2 = new MockFluidDataStoreRuntime();
            containerRuntime2 = containerRuntimeFactory.createContainerRuntime(runtime2);
            sharedString2 = new SharedString(runtime2, "shared-string-2", SharedStringFactory.Attributes);
            const services2: IChannelServices = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString2.initializeLocal();
            sharedString2.connect(services2);
        });

        it("can resend unacked ops on reconnection", async () => {
            // Make couple of changes to the first SharedString.
            sharedString.insertText(0, "helloworld");
            sharedString.replaceText(5, 10, " friend");

            for (let i = 0; i < 10; i++) {
                // Disconnect and reconnect the first collection.
                containerRuntime1.connected = false;
                containerRuntime1.connected = true;
            }

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that the changes were correctly received by the second SharedString
            assert.equal(sharedString2.getText(), "hello friend");
        });

        it("can store ops in disconnected state and resend them on reconnection", async () => {
            // Disconnect the first SharedString.
            containerRuntime1.connected = false;

            // Make couple of changes to it.
            sharedString.insertText(0, "helloworld");
            sharedString.replaceText(5, 10, " friend");

            // Reconnect the first SharedString.
            containerRuntime1.connected = true;

            // Process the messages.
            containerRuntimeFactory.processAllMessages();

            // Verify that the changes were correctly received by the second SharedString
            assert.equal(sharedString2.getText(), "hello friend");
        });
    });
});
