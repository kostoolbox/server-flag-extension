importScripts("countries.js");

const CACHE_TTL_MS = 10 * 60 * 1000; // 域名解析缓存 10 分钟
const domainCache = new Map();       // hostname -> { data, timestamp }
const pendingLookups = new Map();    // hostname -> Promise
const tabConnectedIp = new Map();    // tabId -> { hostname, ip }

// ---------- 工具函数 ----------

function isIPv4(str) {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(str);
}

function isIPv6(str) {
  return str.includes(":") && /^[0-9a-fA-F:]+$/.test(str.replace(/^\[|\]$/g, ""));
}

function isPrivateOrLocalIP(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1" || clean === "::" || clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) {
    return true;
  }
  if (isIPv4(clean)) {
    const parts = clean.split(".").map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  return false;
}

function isLocalHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".lan")) {
    return true;
  }
  if (isIPv4(h) || isIPv6(h)) {
    return isPrivateOrLocalIP(h);
  }
  return false;
}

function extractHostname(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- DNS 解析 (DoH：阿里 DNS -> 腾讯 DNSPod -> Cloudflare) ----------

const DOH_PROVIDERS = [
  {
    name: "阿里 DNS",
    buildUrl: (domain, type) =>
      `https://dns.alidns.com/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
    headers: { Accept: "application/dns-json" }
  },
  {
    name: "腾讯 DNSPod",
    buildUrl: (domain, type) =>
      `https://doh.pub/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
    headers: { Accept: "application/dns-json" }
  },
  {
    name: "Cloudflare DNS",
    buildUrl: (domain, type) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
    headers: { Accept: "application/dns-json" }
  }
];

async function queryDnsRecords(hostname) {
  // 如果直接访问 IP 地址，无需查询 DNS
  if (isIPv4(hostname)) {
    return { ipv4: [hostname], ipv6: [], cnames: [], dnsProvider: "直连 IP" };
  }
  if (isIPv6(hostname)) {
    return { ipv4: [], ipv6: [hostname], cnames: [], dnsProvider: "直连 IP" };
  }

  for (const provider of DOH_PROVIDERS) {
    try {
      const [resA, resAAAA] = await Promise.allSettled([
        fetchJsonWithTimeout(provider.buildUrl(hostname, "A"), { headers: provider.headers }, 4000),
        fetchJsonWithTimeout(provider.buildUrl(hostname, "AAAA"), { headers: provider.headers }, 4000)
      ]);

      const ipv4Set = new Set();
      const ipv6Set = new Set();
      const cnameSet = new Set();
      let gotAnyValid = false;

      const parseAnswers = (res) => {
        if (res.status !== "fulfilled" || !res.value) return;
        gotAnyValid = true;
        const answers = res.value.Answer || [];
        for (const ans of answers) {
          if (!ans || !ans.data) continue;
          const val = String(ans.data).trim().replace(/\.$/, "");
          if (ans.type === 1 && isIPv4(val)) {
            ipv4Set.add(val);
          } else if (ans.type === 28 && isIPv6(val)) {
            ipv6Set.add(val);
          } else if (ans.type === 5 && val) {
            cnameSet.add(val);
          }
        }
      };

      parseAnswers(resA);
      parseAnswers(resAAAA);

      if (gotAnyValid && (ipv4Set.size > 0 || ipv6Set.size > 0 || cnameSet.size > 0)) {
        return {
          ipv4: Array.from(ipv4Set),
          ipv6: Array.from(ipv6Set),
          cnames: Array.from(cnameSet),
          dnsProvider: provider.name
        };
      }
    } catch {
      // 尝试下一个 DoH 节点
    }
  }

  return { ipv4: [], ipv6: [], cnames: [], dnsProvider: "解析失败" };
}

// ---------- IP 归属地查询 (IP.SB -> ipwho.is -> ipapi.co) ----------

async function queryGeoIp(ip) {
  if (!ip || isPrivateOrLocalIP(ip)) {
    return {
      countryCode: "LAN",
      countryName: "局域网 / 本地",
      region: "",
      city: "",
      isp: "",
      asn: ""
    };
  }

  // 节点 1：IP.SB（国内与海外访问均较快）
  try {
    const data = await fetchJsonWithTimeout(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, {}, 4500);
    if (data && data.country_code) {
      const code = String(data.country_code).toUpperCase();
      return {
        countryCode: code,
        countryName: COUNTRY_NAMES_ZH[code] || data.country || code,
        region: data.region || "",
        city: data.city || "",
        isp: data.isp || data.organization || "",
        asn: data.asn ? `AS${data.asn}` : ""
      };
    }
  } catch {
    // 继续尝试备用接口
  }

  // 节点 2：ipwho.is
  try {
    const data = await fetchJsonWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, {}, 4500);
    if (data && data.success && data.country_code) {
      const code = String(data.country_code).toUpperCase();
      return {
        countryCode: code,
        countryName: COUNTRY_NAMES_ZH[code] || data.country || code,
        region: data.region || "",
        city: data.city || "",
        isp: (data.connection && (data.connection.isp || data.connection.org)) || "",
        asn: data.connection && data.connection.asn ? `AS${data.connection.asn}` : ""
      };
    }
  } catch {
    // 继续尝试备用接口
  }

  // 节点 3：ipapi.co
  try {
    const data = await fetchJsonWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {}, 4500);
    if (data && data.country_code && !data.error) {
      const code = String(data.country_code).toUpperCase();
      return {
        countryCode: code,
        countryName: COUNTRY_NAMES_ZH[code] || data.country_name || code,
        region: data.region || "",
        city: data.city || "",
        isp: data.org || "",
        asn: data.asn || ""
      };
    }
  } catch {
    // 全部失败
  }

  return {
    countryCode: "UNKNOWN",
    countryName: "未知归属地",
    region: "",
    city: "",
    isp: "",
    asn: ""
  };
}

// ---------- 综合查询与缓存 ----------

async function resolveHostInfo(hostname, connectedIp = null, forceRefresh = false) {
  if (isLocalHostname(hostname)) {
    return {
      status: "lan",
      hostname,
      connectedIp: connectedIp || (isIPv4(hostname) || isIPv6(hostname) ? hostname : "127.0.0.1"),
      primaryIp: connectedIp || hostname,
      ipv4: isIPv4(hostname) ? [hostname] : [],
      ipv6: isIPv6(hostname) ? [hostname] : [],
      cnames: [],
      dnsProvider: "本地网络",
      geo: {
        countryCode: "LAN",
        countryName: "本地 / 局域网",
        region: "",
        city: "",
        isp: "内网地址",
        asn: ""
      },
      updatedAt: Date.now()
    };
  }

  if (!forceRefresh) {
    const cached = domainCache.get(hostname);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const result = { ...cached.data };
      if (connectedIp && !isPrivateOrLocalIP(connectedIp)) {
        result.connectedIp = connectedIp;
      }
      return result;
    }
  }

  const inflightKey = forceRefresh ? `${hostname}#force` : hostname;
  if (pendingLookups.has(inflightKey)) {
    return pendingLookups.get(inflightKey);
  }

  const promise = (async () => {
    const dns = await queryDnsRecords(hostname);
    const validConnectedIp = connectedIp && !isPrivateOrLocalIP(connectedIp) ? connectedIp : null;

    // 合并实际连接 IP（如有且不在列表中）
    const ipv4 = [...dns.ipv4];
    const ipv6 = [...dns.ipv6];
    if (validConnectedIp) {
      if (isIPv4(validConnectedIp) && !ipv4.includes(validConnectedIp)) {
        ipv4.unshift(validConnectedIp);
      } else if (isIPv6(validConnectedIp) && !ipv6.includes(validConnectedIp)) {
        ipv6.unshift(validConnectedIp);
      }
    }

    // 优先用实际公网连接 IP 查询归属地，其次用 A 记录 IPv4，最后用 AAAA 记录 IPv6
    const primaryIp = validConnectedIp || ipv4[0] || ipv6[0] || null;
    const geo = primaryIp
      ? await queryGeoIp(primaryIp)
      : {
          countryCode: "UNKNOWN",
          countryName: "未能解析服务器 IP",
          region: "",
          city: "",
          isp: "",
          asn: ""
        };

    const result = {
      status: primaryIp ? "ok" : "error",
      hostname,
      connectedIp: validConnectedIp,
      primaryIp,
      ipv4,
      ipv6,
      cnames: dns.cnames,
      dnsProvider: dns.dnsProvider,
      geo,
      updatedAt: Date.now()
    };

    if (result.status === "ok" && result.geo.countryCode !== "UNKNOWN") {
      domainCache.set(hostname, { data: result, timestamp: Date.now() });
    }
    return result;
  })();

  pendingLookups.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    pendingLookups.delete(inflightKey);
  }
}

// ---------- 动态图标绘制与更新 ----------

function drawFallbackBadge(code) {
  const size = 64;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#2563eb";
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 32px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(code.slice(0, 2).toUpperCase(), size / 2, size / 2 + 2);

  return ctx.getImageData(0, 0, size, size);
}

async function setDefaultIcon(tabId, title = "网站服务器国旗") {
  try {
    await chrome.action.setIcon({
      tabId,
      path: {
        16: "icons/icon16.png",
        32: "icons/icon32.png",
        48: "icons/icon48.png",
        128: "icons/icon128.png"
      }
    });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    // 标签页可能已关闭
  }
}

async function applyTabIcon(tabId, info) {
  if (!info || !info.geo) {
    await setDefaultIcon(tabId);
    return;
  }

  const code = (info.geo.countryCode || "").toLowerCase();
  const titleLines = [
    `服务器所在地：${info.geo.countryName}${info.geo.city ? " · " + info.geo.city : ""}`,
    info.primaryIp ? `IP：${info.primaryIp}` : "IP：未解析",
    `域名：${info.hostname}`
  ];
  const title = titleLines.join("\n");

  try {
    if (code === "lan") {
      await chrome.action.setIcon({ tabId, path: { 64: "icons/flags/lan.png" } });
    } else if (BUNDLED_FLAGS.has(code)) {
      await chrome.action.setIcon({ tabId, path: { 64: `icons/flags/${code}.png` } });
    } else if (code && code !== "unknown" && code.length === 2) {
      const imageData = drawFallbackBadge(code);
      await chrome.action.setIcon({ tabId, imageData: { 64: imageData } });
    } else {
      await chrome.action.setIcon({ tabId, path: { 64: "icons/flags/unknown.png" } });
    }
    await chrome.action.setTitle({ tabId, title });
  } catch {
    // 标签页可能已关闭或跳转
  }
}

async function updateTabFlag(tabId, url, forceRefresh = false) {
  const hostname = extractHostname(url);
  if (!hostname) {
    await setDefaultIcon(tabId, "网站服务器国旗（当前页面非网页）");
    return null;
  }

  const recorded = tabConnectedIp.get(tabId);
  const connectedIp = recorded && recorded.hostname === hostname ? recorded.ip : null;

  const info = await resolveHostInfo(hostname, connectedIp, forceRefresh);

  // 确认标签页仍在同一域名，避免异步竞态覆盖
  try {
    const tab = await chrome.tabs.get(tabId);
    if (extractHostname(tab.url) === hostname) {
      await applyTabIcon(tabId, info);
    }
  } catch {
    // 标签页已关闭
  }

  return info;
}

// ---------- 事件监听 ----------

// 捕获 Chrome 实际连接的服务器 IP
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0 || details.type !== "main_frame") return;
    const hostname = extractHostname(details.url);
    if (!hostname) return;
    if (details.ip) {
      tabConnectedIp.set(details.tabId, { hostname, ip: details.ip });
    }
    updateTabFlag(details.tabId, details.url, false);
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }
);

// 标签页加载或切换地址时更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    updateTabFlag(tabId, changeInfo.url, false);
  } else if (changeInfo.status === "complete" && tab.url) {
    updateTabFlag(tabId, tab.url, false);
  }
});

// 切换标签页时确保图标正确显示
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) {
      updateTabFlag(tabId, tab.url, false);
    }
  } catch {
    // 忽略
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabConnectedIp.delete(tabId);
});

// 响应弹窗页面请求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "GET_TAB_INFO" || message.type === "REFRESH_TAB_INFO") {
    const force = message.type === "REFRESH_TAB_INFO";
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) {
          sendResponse({ status: "unsupported", message: "无法获取当前标签页地址" });
          return;
        }
        const hostname = extractHostname(tab.url);
        if (!hostname) {
          sendResponse({ status: "unsupported", message: "当前为浏览器内部页面或本地文件，无远程服务器。" });
          return;
        }
        const info = await updateTabFlag(tab.id, tab.url, force);
        sendResponse(info || { status: "error", message: "查询失败，请点击刷新重试。" });
      } catch (err) {
        sendResponse({ status: "error", message: err.message || "查询出错" });
      }
    })();
    return true; // 异步响应
  }
});
