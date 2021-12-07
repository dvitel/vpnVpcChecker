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

function sleep(delay) {
    return new Promise((res) => setTimeout(() => res(), delay));
}

const downloadOvpn = async (vpnServer, vpnUser, vpnPwd) => {
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
        //         console.log(r, r.request())
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
            console.log("1. client.ovpn download failed from " + url);
            ovpnConfig = null;
        }
        else console.log("1. client.ovpn downloaded from " + url);
    } catch (e) {
        if (verbose) console.error("client.ovpn download: ", e);
        if (e.name == "TimeoutError") {
            if (connected && !auth)
                console.log("1. client.ovpn download auth failed from " + url);
            else 
                console.log("1. client.ovpn download timeout from " + url);
        } else {
            console.log("1. client.ovpn download failed from " + url);
        }
        ovpnConfig = null;
    }
    browser.close();
    return ovpnConfig;
}

const connectOvpn = async (ovpnConfig, vpnUser, vpnPwd, sudoPrefix) => {        
    const vpnPassFile = path.join(__dirname, "pass.txt");
    fs.writeFileSync(vpnPassFile, vpnUser + "\n" + vpnPwd);

    const openvpn = exec(sudoPrefix + "openvpn --config " + ovpnConfig + " --auth-user-pass " + vpnPassFile);
    openvpn.stdout.setEncoding("utf-8");
    openvpn.stderr.setEncoding("utf-8");
    let vpnResolve = null;
    let vpnPromise = new Promise((res) => vpnResolve = res);
    let vpnTimeout = setTimeout(() => vpnResolve(TIMEOUT), config.timeouts.ovpnConnect);
    openvpn.stdout.on("data", (d) => {
        if (verbose) console.log("[openvpn] " + d)
        if (d.includes("Initialization Sequence Completed")) vpnResolve(OK);
    })
    openvpn.stderr.on("data", (d) => { if (verbose) console.error("[openvpn] " + d) })
    openvpn.on("close", () => { if (verbose) console.log("[openvpn] close") });
    let vpnStatus = await vpnPromise;
    clearTimeout(vpnTimeout);
    console.log("2. vpn: " + vpnStatus);
    try { fs.unlinkSync(vpnPassFile) } catch (e) {} //ignore missing file here
    try { fs.unlinkSync(ovpnConfig) } catch (e) {} //ignore missing file here
    return vpnStatus;
}

const connectSsh = async (sshServer, sshUser, sshKey, keyPassphrase) => {
    //node ssh-add should be executed before this 
    const ssh = new Client();

    let sshResolve = null;
    let sshPromise = new Promise((res) => sshResolve = res);
    ssh.once('ready', () => {
        if (verbose) console.log("[ssh] ready");
        sshResolve(OK);
    })
    .once('error', (e) => {
        if (verbose) console.error("[ssh] error", e);
        if (e.message.includes("authentication methods failed")) sshResolve(AUTH_ERROR);
        else if (e.message.includes("Timed out")) sshResolve(TIMEOUT);
        else sshResolve(e.message); //All configured authentication methods failed //Timed out while waiting for handshake
    })
    .connect({
        host: sshServer,
        port: 22,
        username: sshUser,
        privateKey: fs.readFileSync(sshKey),
        passphrase: keyPassphrase,
        readyTimeout: config.timeouts.sshTimeout
    })
    
    const sshRes = await sshPromise;
    // clearTimeout(sshTimeout);
    console.log("3. ssh: " + sshRes + " " + sshServer); 
    ssh.destroy()
    return sshRes;
}

const connectRdp = async (rdpServer, rdpUser, rdpPwd) => {
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
        if (verbose) console.log("[rdp] connected ");
        rdpResolve(OK);
    }).once('error', function(err) {
        if (closed) return;
        if (verbose) console.log("[rdp] error ", err);
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
    //     if (verbose) console.log("[rdp] " + d);
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
    console.log("4. rdp: " + rdpRes + " " + rdpServer); 
    return rdpRes;
}

const cleanup = (sudoPrefix) => {
    try { exec(sudoPrefix + "killall openvpn") } catch (e) {} //ignore errors here
}

const testAll = async ({ id, vpnServer, sshServer, rdpServer }) => {
    let score = config.points.base;    
    let prevLogger = console.log; 
    let log = [];
    console.log = (...args) => {
        log.push(...args);
        prevLogger(...args)
    }
    cleanup(sudoPrefix);
    try {                
        let ovpnConfigFile = await downloadOvpn(vpnServer || config.vpnServer, config.vpnUser, id || config.vpnPwd);
        if (ovpnConfigFile) {
            score += config.points.downloadOvpn;
            let vpnStatus = await connectOvpn(ovpnConfigFile, config.vpnUser, id || config.vpnPwd, sudoPrefix);
            score += (config.points.connectOvpn[vpnStatus] || 0);
            if (vpnStatus == OK) {                
                let sshStatus = await connectSsh(sshServer || config.sshServer, config.sshUser, config.sshKey, config.keyPassphrase);
                score += (config.points.connectSsh[sshStatus] || 0);
                let rdpStatus = await connectRdp(rdpServer || config.rdpServer, config.rdpUser, config.rdpPwd);
                score += (config.points.connectRdp[rdpStatus] || 0);
            }
        }
    } catch (e) {
        console.error("Error: " + e);
    }
    cleanup(sudoPrefix);
    console.log("score: " + score);
    console.log = prevLogger; //restore logger
    return { score, log }
}

module.exports = { downloadOvpn, cleanup, connectRdp, connectSsh, connectOvpn, testAll }

