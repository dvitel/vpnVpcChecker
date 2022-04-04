const fs = require("fs")
const path = require("path");
const p = require("puppeteer");
const { exec } = require("child_process");
const { Client } = require("ssh2");
const { createClient } = require("node-rdpjs-2");
const config = require("./config.json");

// let verbose = true;
let verbose = process.argv.includes("-v");
let gui = process.argv.includes("--gui");
let sudoPrefix = config.sudo ? ("echo " + config.sudo + " | sudo -S ") : "sudo ";

const OK = "OK"
const TIMEOUT = "TIMEOUT"
const AUTH_ERROR = "AUTH_ERROR"
const IP_OK = "IP_OK"

function sleep(delay) {
    return new Promise((res) => setTimeout(() => res(), delay));
}

const downloadOvpn = async (vpnServer, vpnUser, vpnPwd, log, logError) => {
    let url = "https://" + vpnServer + ":943";
    let ovpnConfig = path.join(__dirname, "client.ovpn")
    let connected = false;
    let auth = false;
    try { fs.unlinkSync(ovpnConfig) } catch (e) {} //ignore missing file here
    const browser = await p.launch({ headless: !gui, ignoreHTTPSErrors: true });    
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(config.timeouts.ovpnDownload);        
        await page.goto(url, { waitUntil: 'networkidle2' });
        await Promise.all([page.waitForSelector("#username", { visible: true }), page.waitForSelector("#password", { visible: true })])
        connected = true;
        await page.type("#username", vpnUser);
        await page.type("#password", vpnPwd);
        await page.click("#go");
        await page.waitForSelector("#profiles", { visible: true });
        auth = true;
        await page._client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: __dirname 
        });    
        //assume that jquery is already on page - checked on 12/01/2021 - use addScriptTag otherwise to add jquery
        const link = await page.evaluateHandle(() => {
            return $('a:contains(Yourself):first')[0];
        });        
        // let ovpnResolved = null;
        // let ovpnPromise = new Promise((res) => ovpnResolved = res);
        // let ovpnTimeout = setTimeout(() => ovpnResolved(null), 5000);
        // page.on("response", async (r) => {
        //     if (r.url().endsWith(".ovpn")) {
        //         // ovpnResolved(await r.text());
        //         log(r, r.request())
        //     }
        // });
        await link.click()
        // ovpnConfig = await ovpnPromise;
        // clearTimeout(ovpnTimeout);
        let slept = 0;
        while (slept <= config.timeouts.ovpnDownload) {
            await sleep(1000);
            if (fs.existsSync(ovpnConfig)) break;
            slept += 1000;
        }
        if (slept >= config.timeouts.ovpnDownload) {
            log("client.ovpn download failed from " + url);
            ovpnConfig = null;
        }
        else log("client.ovpn downloaded from " + url);
    } catch (e) {
        if (verbose) logError("client.ovpn download: ", e);
        if (e.name == "TimeoutError") {
            if (connected && !auth)
                log("1. client.ovpn download auth failed from " + url);
            else 
                log("1. client.ovpn download timeout from " + url);
        } else {
            log("1. client.ovpn download failed from " + url);
        }
        ovpnConfig = null;
    }
    browser.close();
    return ovpnConfig;
}

const connectOvpn = async (ovpnConfig, vpnUser, vpnPwd, sudoPrefix, log, logError) => {        
    const vpnPassFile = path.join(__dirname, "pass.txt");
    fs.writeFileSync(vpnPassFile, vpnUser + "\n" + vpnPwd);

    const openvpn = exec(sudoPrefix + "openvpn --config " + ovpnConfig + " --auth-user-pass " + vpnPassFile);
    openvpn.stdout.setEncoding("utf-8");
    openvpn.stderr.setEncoding("utf-8");
    let vpnResolve = null;
    let vpnPromise = new Promise((res) => vpnResolve = res);
    let vpnTimeout = setTimeout(() => vpnResolve(TIMEOUT), config.timeouts.ovpnConnect);
    openvpn.stdout.on("data", (d) => {
        if (verbose) log("[openvpn] " + d)
        if (d.includes("Initialization Sequence Completed")) vpnResolve(OK);
    })
    openvpn.stderr.on("data", (d) => { if (verbose) logError("[openvpn] " + d) })
    openvpn.on("close", () => { if (verbose) log("[openvpn] close") });
    let vpnStatus = await vpnPromise;
    clearTimeout(vpnTimeout);
    log("vpn: " + vpnStatus);
    try { fs.unlinkSync(vpnPassFile) } catch (e) {} //ignore missing file here
    try { fs.unlinkSync(ovpnConfig) } catch (e) {} //ignore missing file here
    return vpnStatus;
}

const connectSsh = async (config, log, logError, cb = null) => {
    //node ssh-add should be executed before this 
    const ssh = new Client();

    let sshResolve = null;
    let sshPromise = new Promise((res) => sshResolve = res);
    ssh.once('ready', async () => {
        if (verbose) log("[ssh] ready");  
        log("ssh: " + (config.host) + " " + OK);       
        var res = await (cb || (async () => {}))(ssh); //allows to do exec or forwardOut
        sshResolve(res || OK);
    })
    .once('error', (e) => {
        if (verbose) logError("[ssh] error" + e.toString());
        var status = e.message;
        if (e.message.includes("authentication methods failed")) status = AUTH_ERROR;
        else if (e.message.includes("Timed out")) status = TIMEOUT;
        log("ssh: " + (config.host) + " " + status);       
        sshResolve(status); //All configured authentication methods failed //Timed out while waiting for handshake
    })
    .connect(config);
        
    //     {
    //     host: sshServer,
    //     port: 22,
    //     username: sshUser,
    //     privateKey: sshKey,
    //     passphrase: keyPassphrase,
    //     readyTimeout: config.timeouts.sshTimeout,
    //     agent: process.env.SSH_AUTH_SOCK,
    //     agentForward: true        
    // }
    
    // )
    
    const sshRes = await sshPromise;    
    // clearTimeout(sshTimeout);    
    ssh.destroy()
    return sshRes;
}

const connectRdp = async (rdpServer, rdpUser, rdpPwd, log, logError) => {
    let rdpResolve = null;
    let rpdPromise = new Promise((res) => rdpResolve = res);
    let connected = false;
    let rdpTimeout = setTimeout(() => rdpResolve(connected ? AUTH_ERROR : TIMEOUT), config.timeouts.rdpTimeout)
    let closed = false;    
    let rdpClient = createClient({
        userName : rdpUser,
        password : rdpPwd,
        enablePerf : true,
        autoLogin : true,
        decompress : false,
        screen : { width : 800, height : 600 },
        locale : 'en',
        logLevel : verbose ? 'INFO' : 'ERROR'
    }).once('connect', () => {
        connected = true;
    })
    .once('session', function () {
        if (verbose) log("[rdp] connected ");
        rdpResolve(OK);
    }).once('error', function(err) {
        if (closed) return;
        if (verbose) log("[rdp] error ", err);
        // if (e.code)
        rdpResolve(err.code);
    }).connect(rdpServer, 3389);

    let rdpRes = await rpdPromise    
    closed = true;
    clearTimeout(rdpTimeout)
    rdpClient.close();
    rdpClient.bufferLayer.socket.destroy();
    // const rdpProc = exec("xfreerdp /v:" + windows + " /u:Administrator /p:CloudComputing /cert:ignore");    
    // let rdpResolve = null;
    // let rdpReject = null;
    // let rpdPromise = new Promise((res, rej) => { rdpResolve = res; rdpReject = rej });
    // let rdpTimeout = setTimeout(() => rdpResolve("RDP timeout"), 10000);
    // // setTimeout(() => , 7000);
    // rdpProc.stdout.setEncoding("utf-8")
    // rdpProc.stderr.setEncoding("utf-8")
    // rdpProc.stdout.on("data", (d) => {
    //     if (verbose) log("[rdp] " + d);
    //     if (d.includes("Loaded fake backend for rdpsnd")) rdpResolve("works")
    // })
    // rdpProc.stdout.
    // rdpProc.stderr.on("data", (d) => {
    //     if (verbose) console.error("[rdp] " + d);
    //     rdpResolve(d.includes("ERRCONNECT_LOGON_FAILURE") ? "Password is wrong" : "Connect issues")
    // })
    // // try { exec("echo " + sudo + " | sudo -S killall xfreerdp") } catch (e) {} //ignore errors here
    // const rdpRes = await rpdPromise;
    // clearTimeout(rdpTimeout);
    // // rdpProc.kill("SIGINT");
    // exec("killall -s SIGINT xfreerdp");
    log("rdp: " + rdpRes + " " + rdpServer); 
    return rdpRes;
}

const cleanup = (sudoPrefix) => {
    try { exec(sudoPrefix + "killall openvpn") } catch (e) {} //ignore errors here
}

const withLog = async (action) => {
    let logL = [];
    let log = (...msg) => {
        logL.push(msg.map(x => x.toString()).join(""));
        if (verbose) { 
            console.log(...msg);
        }
    }
    let logError = (...msg) => {
        logL.push(msg.map(x => x.toString()).join(""));
        if (verbose) {
            console.error(...msg);
        }
    }
    var res = await action(log, logError);
    res = res || {};
    res.log = logL; 
    return res;
}

const testVpnVpc = async ({ id, vpnServer, sshServer, rdpServer, sshKey }) => {
    let score = config.points.base;        
    let res = await withLog(async (log, logError) => {
        cleanup(sudoPrefix);
        try {                
            let ovpnConfigFile = await downloadOvpn(vpnServer || config.vpnServer, config.vpnUser, id || config.vpnPwd, log, logError);
            if (ovpnConfigFile) {
                score += config.points.downloadOvpn;
                let vpnStatus = await connectOvpn(ovpnConfigFile, config.vpnUser, id || config.vpnPwd, sudoPrefix, log, logError);
                score += (config.points.connectOvpn[vpnStatus] || 0);
                if (vpnStatus == OK) {         
                    let config = {
                        host: sshServer || config.sshServer,
                        port: 22,
                        username: config.sshUser,
                        privateKey: sshKey,
                        passphrase: config.keyPassphrase,
                        readyTimeout: config.timeouts.sshTimeout,
                        // agent: process.env.SSH_AUTH_SOCK,
                        // agentForward: true                   
                    }       
                    let sshStatus = await connectSsh(config, log, logError);
                    score += (config.points.connectSsh[sshStatus] || 0);
                    let rdpStatus = await connectRdp(rdpServer || config.rdpServer, config.rdpUser, config.rdpPwd, log, logError);
                    score += (config.points.connectRdp[rdpStatus] || 0);
                }
            }
        } catch (e) {
            logError("Error: " + e.toString());
        }
        cleanup(sudoPrefix);
        log("score: " + score);
        return { score };
    });
    return res;
}

//analysis of ip -4 -br a output according to assignment
const analyzeIp = (buffer, lineRegex, expectedMask) => {
    var lines = buffer.split("\n");
    lines = lines.filter(l => !l.startsWith("lo "))
    return lines.find(l => {
        var res = null;
        if (res = l.match(lineRegex)) {
            if (res.groups.mask == expectedMask)  {
                return true;
            }
        }
        return false;
    })
}

const sshExec = async (conn, cmd, log, logError, outputAnalysis, header = "") => {
    // var ipCmd = "/sbin/ip -4 -br a"
    var buffer = "";
    let cmdResolve = null;
    let cmdPromise = new Promise((res) => cmdResolve = res);
    let res = null;
    conn.exec(cmd, (err, stream) => {
        if (err) {
            logError(header + err.message);           
            cmdResolve();             
        } else {
            stream.on('data', (data) => {
                buffer += data.toString();
            })
            .on('close', () => {
                // log(buffer);
                res = outputAnalysis(buffer);
                cmdResolve();
            })
            .stderr.on('data', (data) => {
                buffer += data.toString();
            })
        }                    
    });

    await cmdPromise;
    return res;
}

const ipCmd = "/sbin/ip -4 -br a"

const testPrivateUbuntu = async (conn, sshServer, sshKey, log, logError) => {
    sshServer = sshServer || config.sshServer;    
    let fwdResolve = null;
    let fwdPromise = new Promise((res) => fwdResolve = res);
    let res = "";
    // var cmd = `ssh -o ConnectTimeout=3 ${config.sshUser}@${sshServer} -f '/sbin/ip -4 -br a'`;
    // var res = await sshExec(conn, cmd, log, logError, (buffer) => {
    //     if (buffer.startsWith("Permission denied")) {
    //         log("ssh: " + (sshServer || config.sshServer) + " auth failed. Check staff key was added.");
    //         res = AUTH_ERROR;
    //     } else if (buffer.includes("Connection timed out")) {
    //         log("ssh: " + (sshServer || config.sshServer) + " timeout. Check ip address correctness.");
    //         res = TIMEOUT;
    //     } else {
    //         var foundLine = analyzeIp(buffer, /172\.16\.1[01]\.\d+\/(?<mask>\d+)/, "23");
    //         if (foundLine) {
    //             foundLine = foundLine.split(" ").filter(x => x != "").join(" ");
    //             log("Private Ubuntu net: " + foundLine);
    //             return foundLine;
    //         } else {
    //             log("Private Ubuntu net: cannot find expected network configuration. Check assignment requirements.");
    //             log(buffer);
    //         }
    //         return null;
    //     }
    // }, "Private Ubuntu: ");
    // return res;

    conn.forwardOut('127.0.0.1', 0, sshServer, 22, async (err, stream) => {
        if (err) {
            log("Cannot forward: " + err);
            fwdResolve();
            return;
        }
        let privateConfig = {
            sock: stream,
            host: sshServer,
            username: config.sshUser,
            privateKey: sshKey,
            passphrase: config.keyPassphrase,
            readyTimeout: config.timeouts.sshTimeout,
            // agent: process.env.SSH_AUTH_SOCK,
            // agentForward: true                   
        }  
        let privateSsh = await connectSsh(privateConfig, log, logError, async (conn2) => {
            let foundLine = await sshExec(conn2, ipCmd, log, logError, (buffer) => {
                var foundLine = analyzeIp(buffer, /172\.16\.1[01]\.\d+\/(?<mask>\d+)/, "23");
                if (foundLine) {
                    foundLine = foundLine.split(" ").filter(x => x != "").join(" ");
                    log("Private Ubuntu net: " + foundLine);
                    return foundLine;
                } else {
                    log("Private Ubuntu net: cannot find expected network configuration. Check assignment requirements.");
                    log(buffer);
                }
                return null;
            }, "Private Ubuntu net: ")
            if (foundLine) return IP_OK;
            return OK;
        })
        res = privateSsh;
        fwdResolve();
    })

    await fwdPromise;
    return res;
}

const testVpc = async ({ bastionServer, sshServer, sshKey }) => {
    let score = config.points.vpc.base;  
    let res = await withLog(async (log, logError) => {
        try {              
            let bastionConfig = {
                host: bastionServer || config.bastionServer,
                port: 22,
                username: config.bastionUser,
                privateKey: sshKey,
                passphrase: config.keyPassphrase,
                readyTimeout: config.timeouts.sshTimeout
                // agent: process.env.SSH_AUTH_SOCK,
                // agentForward: true    
            }                  
            let sshStatus = await connectSsh(bastionConfig, log, logError, cb = async (conn) => {                
                //connect is ok - check ip addr of Bastion 
                let foundLine = await sshExec(conn, ipCmd, log, logError, (buffer) => {
                    var foundLine = analyzeIp(buffer, /172\.16\.8\.\d+\/(?<mask>\d+)/, "26");
                    if (foundLine) {
                        foundLine = foundLine.split(" ").filter(x => x != "").join(" ");
                        log("Bastion net: " + foundLine);
                        return foundLine;
                    } else {
                        log("Bastion net: cannot find expected network configuration. Check assignment requirements.");
                        log(buffer);
                    }    
                    return null;
                }, "Bastion net: ");
                if (foundLine) score += config.points.vpc.bastionNetConfig;
                var status = await testPrivateUbuntu(conn, sshServer, sshKey, log, logError);
                score += (config.points.vpc.privateHost[status] || 0);
            })
            score += (config.points.vpc.bastionConnect[sshStatus] || 0);
        } catch (e) {
            logError("Error: " + e.toString());
        }
        log("score: " + score);
        return { score };
    })
    return res;
}

module.exports = { downloadOvpn, cleanup, connectRdp, connectSsh, connectOvpn, testVpnVpc, testVpc }

