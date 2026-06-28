"use strict";

/**
 * Standalone SECURED OPC-UA test server for manual / container security testing.
 * - Anonymous disabled; user operator/secret123
 * - Policies: None + Basic256Sha256; Modes: None, Sign, SignAndEncrypt
 *
 * Usage: node test/helpers/secure-server.js [port]
 */
const os = require("os");
const path = require("path");
const {
    OPCUAServer, Variant, DataType, nodesets,
    MessageSecurityMode, SecurityPolicy, OPCUACertificateManager
} = require("node-opcua");

const port = parseInt(process.argv[2], 10) || 4842;

(async () => {
    const serverCertificateManager = new OPCUACertificateManager({
        rootFolder: path.join(os.tmpdir(), "nropcua-secure-server-pki"),
        automaticallyAcceptUnknownCertificate: true // server trusts connecting clients (demo)
    });
    await serverCertificateManager.initialize();

    const server = new OPCUAServer({
        port,
        resourcePath: "/UA/Secure",
        nodeset_filename: [nodesets.standard],
        serverCertificateManager,
        allowAnonymous: false,
        securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
        securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
        userManager: { isValidUser: (u, p) => u === "operator" && p === "secret123" },
        buildInfo: { productName: "NodeRedOpcuaSecureTestServer" }
    });

    await server.initialize();
    const ns = server.engine.addressSpace.getOwnNamespace();
    const obj = ns.addObject({ organizedBy: server.engine.addressSpace.rootFolder.objects, browseName: "SecureDevice" });
    let temperature = 30.0;
    ns.addVariable({
        componentOf: obj, nodeId: "ns=1;s=Temperature", browseName: "Temperature",
        dataType: "Double", minimumSamplingInterval: 200,
        value: { get: () => new Variant({ dataType: DataType.Double, value: temperature }) }
    });
    setInterval(() => { temperature = Math.round((temperature + 0.5) * 100) / 100; }, 1000);

    await server.start();
    console.log("SECURE_OPCUA_READY port=" + port);
    console.log("endpoint=" + server.getEndpointUrl());
    console.log("auth: operator / secret123 (anonymous disabled)");

    process.on("SIGINT", async () => { await server.shutdown(); process.exit(0); });
    process.on("SIGTERM", async () => { await server.shutdown(); process.exit(0); });
})().catch((e) => { console.error("SECURE_SERVER_FAIL", e); process.exit(1); });
