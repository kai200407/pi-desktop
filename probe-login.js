// 独立探针：完整走一遍 Google 登录，用主进程侧 API 取证（不经 CDP，避免读到旧文档）
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const path=require("node:path"), fs=require("node:fs");
app.commandLine.appendSwitch("disable-blink-features","AutomationControlled");
const CM=process.versions.chrome.split(".")[0];
const SEC=`"Not=A?Brand";v="99", "Google Chrome";v="${CM}", "Chromium";v="${CM}"`;
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1200,height:900,show:false});
  const ses=session.fromPartition("persist:probe-login-"+Date.now());
  const ua=ses.getUserAgent().replace(/ Electron\/[\d.]+/gi,"").replace(/ probe-login\/[\d.]+/gi,"")
           .replace(/Chrome\/[\d.]+/i,`Chrome/${CM}.0.0.0`);
  ses.setUserAgent(ua);
  ses.webRequest.onBeforeSendHeaders((d,cb)=>{const h=d.requestHeaders;
    h["User-Agent"]=ua;h["sec-ch-ua"]=SEC;h["sec-ch-ua-mobile"]="?0";h["sec-ch-ua-platform"]='"macOS"';cb({requestHeaders:h});});
  const v=new WebContentsView({webPreferences:{session:ses,sandbox:false,contextIsolation:false,
    preload:path.join(__dirname,"browser-preload.js")}});
  win.contentView.addChildView(v); v.setBounds({x:0,y:0,width:1200,height:900});
  const wc=v.webContents;
  await wc.loadURL("https://accounts.google.com/ServiceLogin?hl=zh-CN");
  await new Promise(r=>setTimeout(r,4000));
  console.log("[L] 指纹:",JSON.stringify(await wc.executeJavaScript(
    "({e:/Electron/i.test(navigator.userAgent),b:(navigator.userAgentData?.brands||[]).map(x=>x.brand),wd:navigator.webdriver})")));
  await wc.executeJavaScript(`(()=>{const i=document.querySelector('#identifierId')||document.querySelector('input[type=email]');
    if(!i)return 'no';i.focus();i.value='wyk040721@gmail.com';i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';})()`);
  await new Promise(r=>setTimeout(r,1200));
  await wc.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/下一步|Next/.test(x.innerText));if(b)b.click();return !!b;})()`);
  await new Promise(r=>setTimeout(r,9000));
  const st=await wc.executeJavaScript(`({url:location.href,pwd:!!document.querySelector('input[type=password]'),
     txt:document.body.innerText.replace(/\\n+/g,' | ').slice(0,400)})`);
  console.log("[L] URL:",st.url.slice(0,90));
  console.log("[L] 有密码框:",st.pwd);
  console.log("[L] rejected:",/rejected/.test(st.url));
  console.log("[L] 文案:",st.txt.slice(0,300));
  app.exit(0);
});
