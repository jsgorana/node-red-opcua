"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const should = require("should");
const {
    OPCUAServer, Variant, DataType, nodesets,
    MessageSecurityMode, SecurityPolicy, OPCUACertificateManager
} = require("node-opcua");
const { ConnectionManager } = require("../nodes/lib/connection-manager.js");

function tmpPki(tag) {
    return path.join(os.tmpdir(), "nropcua-test-pki", tag + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
}

describe("Security (integration)", function () {
    this.timeout(40000);

    const PORT = 4871;
    const URL = "opc.tcp://localhost:" + PORT + "/UA/Secure";
    let server;

    before(async () => {
        const serverPki = tmpPki("server");
        const serverCertificateManager = new OPCUACertificateManager({
            rootFolder: serverPki,
            automaticallyAcceptUnknownCertificate: true // test: server trusts client certs
        });
        await serverCertificateManager.initialize();

        server = new OPCUAServer({
            port: PORT,
            resourcePath: "/UA/Secure",
            nodeset_filename: [nodesets.standard],
            serverCertificateManager,
            allowAnonymous: false,
            securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
            securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
            userManager: { isValidUser: (u, p) => u === "operator" && p === "secret123" },
            buildInfo: { productName: "SecurityTestServer" }
        });
        await server.initialize();
        const ns = server.engine.addressSpace.getOwnNamespace();
        const obj = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: "Dev" });
        let v = 11.0;
        ns.addVariable({
            componentOf: obj, nodeId: "ns=1;s=Val", browseName: "Val", dataType: "Double",
            minimumSamplingInterval: 200,
            value: { get: () => new Variant({ dataType: DataType.Double, value: v }) }
        });
        await server.start();
    });

    after(async () => {
        if (server) await server.shutdown();
    });

    async function tryConnect(cfg) {
        const cm = new ConnectionManager(Object.assign({
            endpointUrl: URL, applicationName: "node-red-opcua", timeout: 8000
        }, cfg));
        try {
            await cm.connect();
            return { ok: true, state: cm.state, cm };
        } catch (e) {
            return { ok: false, error: e.message, cm };
        } finally {
            cm.refCount = 0;
            try { await cm.disconnect(); } catch (_e) {}
        }
    }

    it("rejects anonymous when the server disallows it", async () => {
        const r = await tryConnect({ securityMode: "None", securityPolicy: "None", authType: "anonymous" });
        r.ok.should.equal(false);
    });

    it("accepts correct username/password", async () => {
        const r = await tryConnect({
            securityMode: "None", securityPolicy: "None",
            authType: "username", username: "operator", password: "secret123"
        });
        r.ok.should.equal(true);
        r.state.should.equal("connected");
    });

    it("rejects a wrong password", async () => {
        const r = await tryConnect({
            securityMode: "None", securityPolicy: "None",
            authType: "username", username: "operator", password: "WRONG"
        });
        r.ok.should.equal(false);
        r.error.should.match(/AccessDenied|Identity|rejected/i);
    });

    it("connects with Sign + Basic256Sha256 (trusting the server cert)", async () => {
        const r = await tryConnect({
            securityMode: "Sign", securityPolicy: "Basic256Sha256",
            authType: "username", username: "operator", password: "secret123",
            pkiFolder: tmpPki("client-sign"), acceptUntrusted: true
        });
        r.ok.should.equal(true);
        r.state.should.equal("connected");
    });

    it("connects with SignAndEncrypt + Basic256Sha256", async () => {
        const r = await tryConnect({
            securityMode: "SignAndEncrypt", securityPolicy: "Basic256Sha256",
            authType: "username", username: "operator", password: "secret123",
            pkiFolder: tmpPki("client-enc"), acceptUntrusted: true
        });
        r.ok.should.equal(true);
        r.state.should.equal("connected");
    });

    it("SECURE BY DEFAULT: rejects an untrusted server certificate", async () => {
        const r = await tryConnect({
            securityMode: "SignAndEncrypt", securityPolicy: "Basic256Sha256",
            authType: "username", username: "operator", password: "secret123",
            pkiFolder: tmpPki("client-strict"), acceptUntrusted: false
        });
        r.ok.should.equal(false); // server cert is unknown -> validation rejects it
    });

    it("persists the client application certificate in the PKI folder", async () => {
        const pki = tmpPki("client-persist");
        await tryConnect({
            securityMode: "Sign", securityPolicy: "Basic256Sha256",
            authType: "username", username: "operator", password: "secret123",
            pkiFolder: pki, acceptUntrusted: true
        });
        fs.existsSync(path.join(pki, "own", "certs")).should.equal(true);
    });

    it("warns about deprecated policies and credentials over an open channel", () => {
        const cm = new ConnectionManager({
            endpointUrl: URL, securityMode: "None", securityPolicy: "Basic256",
            authType: "username", username: "operator", password: "secret123"
        });
        const w = cm.securityWarnings().join(" ");
        w.should.match(/deprecated/i);
        w.should.match(/unencrypted channel/i);
    });
});
