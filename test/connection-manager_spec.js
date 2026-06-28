"use strict";

const EventEmitter = require("events");
const should = require("should");
const { AttributeIds } = require("node-opcua");
const { ConnectionManager } = require("../nodes/lib/connection-manager.js");
const { startTestServer } = require("./helpers/test-server.js");

describe("ConnectionManager (integration)", function () {
    this.timeout(20000);

    let test;

    before(async () => {
        test = await startTestServer(0);
    });

    after(async () => {
        if (test) await test.stop();
    });

    it("connects and opens a session against a real server", async () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });
        const states = [];
        cm.onState((s) => states.push(s));

        await cm.connect();
        cm.state.should.equal("connected");
        should.exist(cm.session);
        states.should.containEql("connecting");
        states.should.containEql("connected");

        // session is usable
        const dv = await cm.session.read({
            nodeId: "ns=1;s=Temperature",
            attributeId: AttributeIds.Value
        });
        dv.value.value.should.equal(25);

        await cm.disconnect();
        cm.state.should.equal("closed");
    });

    it("dedups concurrent connect() calls into one session", async () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });

        await Promise.all([cm.connect(), cm.connect(), cm.connect()]);
        cm.state.should.equal("connected");

        await cm.disconnect();
    });

    it("onState returns an idempotent unsubscribe function", () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });
        const states = [];
        const unsubscribe = cm.onState((s) => states.push(s));

        cm._setState("connecting");
        unsubscribe();
        unsubscribe();
        cm._setState("connected");

        states.should.deepEqual(["connecting"]);
        cm.listeners.length.should.equal(0);
    });

    it("_waitUntilConnected times out without leaking listeners", async () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous",
            timeout: 30
        });
        cm.state = "reconnecting";

        let err = null;
        try {
            await cm._waitUntilConnected();
        } catch (e) {
            err = e;
        }

        should.exist(err);
        err.message.should.match(/Timed out waiting/);
        cm.listeners.length.should.equal(0);
    });

    it("surfaces initial connect backoff as an error state", () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });
        const fakeClient = new EventEmitter();
        const states = [];
        cm.onState((s) => states.push(s));

        cm._wireClientEvents(fakeClient);
        fakeClient.emit("backoff", 1, 1000);

        cm.state.should.equal("error");
        cm.lastError.message.should.match(/unreachable/);
        states.should.containEql("error");
    });

    it("reports connection diagnostics", () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });
        cm.acquire();

        const diagnostics = cm.diagnostics();
        diagnostics.state.should.equal("closed");
        diagnostics.endpointUrl.should.equal(test.endpointUrl);
        diagnostics.securityMode.should.equal("None");
        diagnostics.authType.should.equal("anonymous");
        diagnostics.refCount.should.equal(1);
        diagnostics.listenerCount.should.equal(0);
        should(diagnostics.lastError).equal(null);
    });

    it("uses one shared subscription for multiple monitored items", async () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });
        await cm.connect();

        const first = await cm.monitorValue({
            nodeId: "ns=1;s=Temperature",
            samplingInterval: 100,
            publishingInterval: 100,
            onChanged: () => {}
        });
        const shared = cm._sharedSubscription;
        const second = await cm.monitorValue({
            nodeId: "ns=1;s=Label",
            samplingInterval: 100,
            publishingInterval: 100,
            onChanged: () => {}
        });

        should.exist(shared);
        cm._sharedSubscription.should.equal(shared);

        await first.terminate();
        await second.terminate();
        await cm.disconnect();
    });

    it("ref-counts: disconnects only when last consumer releases", async () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });

        cm.acquire();
        cm.acquire();
        await cm.connect();

        await cm.release();
        cm.state.should.equal("connected"); // still one consumer

        await cm.release();
        cm.state.should.equal("closed"); // last one out
    });

    it("runWithTimeout fails fast against an unreachable server", async () => {
        const cm = new ConnectionManager({
            // 4900 has no server listening
            endpointUrl: "opc.tcp://127.0.0.1:4900",
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous",
            timeout: 800
        });

        const start = Date.now();
        let err = null;
        try {
            await cm.runWithTimeout(async () => {
                const session = await cm.getSession();
                return session.read({ nodeId: "ns=0;i=2258", attributeId: AttributeIds.Value });
            }, "read");
        } catch (e) {
            err = e;
        }
        const elapsed = Date.now() - start;

        should.exist(err);
        err.message.should.match(/timed out/);
        elapsed.should.be.below(2500); // fails fast, not hanging on infinite retry

        // teardown the still-retrying client
        cm.refCount = 0;
        await cm.disconnect();
    });

    it("operation during a reconnect times out cleanly (no 'invalid internal state')", async () => {
        const srv = await startTestServer(0);
        const cm = new ConnectionManager({
            endpointUrl: srv.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous",
            timeout: 1000
        });

        await cm.connect();
        const ok = await cm.runWithTimeout(async () => {
            const s = await cm.getSession();
            return s.read({ nodeId: "ns=1;s=Temperature", attributeId: AttributeIds.Value });
        }, "read");
        ok.value.value.should.equal(25);

        // server goes away mid-flight
        await srv.stop();

        let err = null;
        try {
            await cm.runWithTimeout(async () => {
                const s = await cm.getSession();
                return s.read({ nodeId: "ns=1;s=Temperature", attributeId: AttributeIds.Value });
            }, "read");
        } catch (e) {
            err = e;
        }
        should.exist(err);
        err.message.should.match(/timed out/);
        err.message.should.not.match(/invalid internal state/);

        cm.refCount = 0;
        await cm.disconnect();
    });

    it("getSession() establishes a connection on demand", async () => {
        const cm = new ConnectionManager({
            endpointUrl: test.endpointUrl,
            securityMode: "None",
            securityPolicy: "None",
            authType: "anonymous"
        });

        const session = await cm.getSession();
        should.exist(session);
        cm.state.should.equal("connected");

        await cm.disconnect();
    });
});
