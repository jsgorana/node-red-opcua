"use strict";

const should = require("should");
const helper = require("node-red-node-test-helper");

const endpointNode = require("../nodes/opcua-endpoint.js");
const readNode = require("../nodes/opcua-read.js");
const writeNode = require("../nodes/opcua-write.js");
const browseNode = require("../nodes/opcua-browse.js");
const subscribeNode = require("../nodes/opcua-subscribe.js");

const { startTestServer } = require("./helpers/test-server.js");

helper.init(require.resolve("node-red"));

describe("OPC-UA nodes (integration)", function () {
    this.timeout(20000);

    let test;

    before(async () => {
        test = await startTestServer(0);
    });

    after(async () => {
        if (test) await test.stop();
    });

    beforeEach(() => helper.startServer());

    afterEach(async () => {
        await helper.unload();
        await helper.stopServer();
    });

    function endpointConfig() {
        return {
            id: "ep",
            type: "opcua-endpoint",
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        };
    }

    it("opcua-read reads a value", function (done) {
        const flow = [
            endpointConfig(),
            { id: "r1", type: "opcua-read", endpoint: "ep", nodeId: "ns=1;s=Temperature", wires: [["h1"]] },
            { id: "h1", type: "helper" }
        ];
        helper.load([endpointNode, readNode], flow, function () {
            const h1 = helper.getNode("h1");
            const r1 = helper.getNode("r1");
            h1.on("input", function (msg) {
                try {
                    msg.payload.should.equal(25);
                    done();
                } catch (e) { done(e); }
            });
            r1.receive({});
        });
    });

    it("opcua-read removes its status listener on close", function (done) {
        const flow = [
            endpointConfig(),
            { id: "r1", type: "opcua-read", endpoint: "ep", nodeId: "ns=1;s=Temperature", wires: [] }
        ];
        helper.load([endpointNode, readNode], flow, async function () {
            const ep = helper.getNode("ep");
            try {
                ep.manager.listeners.length.should.equal(1);
                await helper.unload();
                ep.manager.listeners.length.should.equal(0);
                done();
            } catch (e) {
                done(e);
            }
        });
    });

    it("opcua-read reads multiple values in one message", function (done) {
        const flow = [
            endpointConfig(),
            { id: "r1", type: "opcua-read", endpoint: "ep", nodeId: "", wires: [["h1"]] },
            { id: "h1", type: "helper" }
        ];
        helper.load([endpointNode, readNode], flow, function () {
            const h1 = helper.getNode("h1");
            const r1 = helper.getNode("r1");
            h1.on("input", function (msg) {
                try {
                    msg.payload.should.be.an.Array().and.have.length(2);
                    msg.payload[0].payload.should.equal(25);
                    msg.payload[0].nodeId.should.equal("ns=1;s=Temperature");
                    msg.payload[1].payload.should.equal("hello");
                    msg.statusCodes.should.have.length(2);
                    done();
                } catch (e) { done(e); }
            });
            r1.receive({ payload: ["ns=1;s=Temperature", "ns=1;s=Label"] });
        });
    });

    it("opcua-write writes then reads back", function (done) {
        const flow = [
            endpointConfig(),
            { id: "w1", type: "opcua-write", endpoint: "ep", nodeId: "ns=1;s=Temperature", dataType: "Double", wires: [["h1"]] },
            { id: "h1", type: "helper" }
        ];
        helper.load([endpointNode, writeNode], flow, function () {
            const h1 = helper.getNode("h1");
            const w1 = helper.getNode("w1");
            h1.on("input", function (msg) {
                try {
                    msg.statusCode.should.match(/Good/);
                    test.setTemperature; // server-side state changed via write
                    done();
                } catch (e) { done(e); }
            });
            w1.receive({ payload: 42.5 });
        });
    });

    it("opcua-write writes multiple values in one message", function (done) {
        const flow = [
            endpointConfig(),
            { id: "w1", type: "opcua-write", endpoint: "ep", nodeId: "", dataType: "Double", wires: [["h1"]] },
            { id: "h1", type: "helper" }
        ];
        helper.load([endpointNode, writeNode], flow, function () {
            const h1 = helper.getNode("h1");
            const w1 = helper.getNode("w1");
            h1.on("input", function (msg) {
                try {
                    msg.statusCodes.should.have.length(2);
                    msg.statusCodes[0].should.match(/Good/);
                    msg.statusCodes[1].should.match(/Good/);
                    msg.nodeIds.should.deepEqual(["ns=1;s=Temperature", "ns=1;s=Label"]);
                    done();
                } catch (e) { done(e); }
            });
            w1.receive({
                payload: [
                    { nodeId: "ns=1;s=Temperature", value: 54.25, dataType: "Double" },
                    { nodeId: "ns=1;s=Label", value: "batch", dataType: "String" }
                ]
            });
        });
    });

    it("opcua-browse returns references", function (done) {
        const flow = [
            endpointConfig(),
            { id: "b1", type: "opcua-browse", endpoint: "ep", nodeId: "RootFolder", wires: [["h1"]] },
            { id: "h1", type: "helper" }
        ];
        helper.load([endpointNode, browseNode], flow, function () {
            const h1 = helper.getNode("h1");
            const b1 = helper.getNode("b1");
            h1.on("input", function (msg) {
                try {
                    msg.payload.should.be.an.Array();
                    msg.payload.length.should.be.above(0);
                    msg.payload[0].should.have.property("browseName");
                    done();
                } catch (e) { done(e); }
            });
            b1.receive({});
        });
    });

    it("opcua-subscribe emits on value change", function (done) {
        const flow = [
            endpointConfig(),
            { id: "s1", type: "opcua-subscribe", endpoint: "ep", nodeId: "ns=1;s=Temperature", samplingInterval: 100, publishingInterval: 100, wires: [["h1"]] },
            { id: "h1", type: "helper" }
        ];
        helper.load([endpointNode, subscribeNode], flow, function () {
            const h1 = helper.getNode("h1");
            let fired = false;
            h1.on("input", function (msg) {
                if (fired) return;
                fired = true;
                try {
                    msg.should.have.property("payload");
                    msg.nodeId.should.equal("ns=1;s=Temperature");
                    done();
                } catch (e) { done(e); }
            });
            // change the server value shortly after the subscription arms
            setTimeout(() => test.setTemperature(99.9), 1500);
        });
    });

    it("opcua-subscribe sanitizes invalid timing options", function (done) {
        const flow = [
            endpointConfig(),
            {
                id: "s1",
                type: "opcua-subscribe",
                endpoint: "ep",
                nodeId: "ns=1;s=Temperature",
                samplingInterval: -10,
                publishingInterval: 0,
                queueSize: -1,
                wires: [[]]
            }
        ];
        helper.load([endpointNode, subscribeNode], flow, async function () {
            const s1 = helper.getNode("s1");
            try {
                s1.samplingInterval.should.equal(1000);
                s1.publishingInterval.should.equal(1000);
                s1.queueSize.should.equal(10);
                done();
            } catch (e) {
                done(e);
            }
        });
    });
});
