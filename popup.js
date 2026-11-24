const flagImg = document.getElementById("flagImg");
const countryNameEl = document.getElementById("countryName");
const countryCodeEl = document.getElementById("countryCode");
const locationSubEl = document.getElementById("locationSub");
const refreshBtn = document.getElementById("refreshBtn");
const statusBox = document.getElementById("statusBox");
const contentArea = document.getElementById("contentArea");
const domainText = document.getElementById("domainText");
const cnameRow = document.getElementById("cnameRow");
const cnameList = document.getElementById("cnameList");
const ipv4List = document.getElementById("ipv4List");
const ipv6List = document.getElementById("ipv6List");
const ispRow = document.getElementById("ispRow");
const ispText = document.getElementById("ispText");
const dnsSourceText = document.getElementById("dnsSourceText");

function setLoading(loading) {
  refreshBtn.disabled = loading;
  refreshBtn.textContent = loading ? "查询中..." : "刷新";
  if (loading) {
    countryNameEl.textContent = "正在查询...";
    countryCodeEl.textContent = "";
    locationSubEl.textContent = "正在解析 DNS 记录与服务器归属地";
  }
}

function getFlagSrc(countryCode) {
  const code = (countryCode || "").toLowerCase();
  if (code === "lan") return "icons/flags/lan.png";
  if (typeof BUNDLED_FLAGS !== "undefined" && BUNDLED_FLAGS.has(code)) {
    return `icons/flags/${code}.png`;
  }
  return "icons/flags/unknown.png";
}

function renderIpList(container, ips, connectedIp, emptyText) {
  container.innerHTML = "";
  if (!ips || ips.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-tip";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  ips.forEach((ip) => {
    const item = document.createElement("div");
    item.className = "ip-item";

    const left = document.createElement("div");
    left.className = "ip-left";

    const ipSpan = document.createElement("span");
    ipSpan.className = "ip-text";
    ipSpan.textContent = ip;
    left.appendChild(ipSpan);

    if (connectedIp && ip.toLowerCase() === connectedIp.toLowerCase()) {
      const badge = document.createElement("span");
      badge.className = "connected-badge";
      badge.textContent = "当前连接";
      left.appendChild(badge);
    }

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ip);
        copyBtn.textContent = "已复制";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "复制";
          copyBtn.classList.remove("copied");
        }, 1200);
      } catch {
        copyBtn.textContent = "失败";
      }
    });

    item.appendChild(left);
    item.appendChild(copyBtn);
    container.appendChild(item);
  });
}

function renderData(data) {
  if (!data || data.status === "unsupported") {
    flagImg.src = "icons/icon48.png";
    countryNameEl.textContent = "无远程服务器";
    countryCodeEl.textContent = "";
    locationSubEl.textContent = "浏览器内置页面或本地文件";
    contentArea.classList.add("hidden");
    statusBox.classList.remove("hidden");
    statusBox.textContent = (data && data.message) || "当前页面不是可解析的网站地址。";
    return;
  }

  statusBox.classList.add("hidden");
  contentArea.classList.remove("hidden");

  const geo = data.geo || {};
  flagImg.src = getFlagSrc(geo.countryCode);
  countryNameEl.textContent = geo.countryName || "未知归属地";
  countryCodeEl.textContent =
    geo.countryCode && geo.countryCode !== "UNKNOWN" ? geo.countryCode : "";

  const subParts = [];
  if (geo.region && geo.region !== geo.countryName) subParts.push(geo.region);
  if (geo.city && geo.city !== geo.region) subParts.push(geo.city);
  locationSubEl.textContent =
    subParts.length > 0 ? subParts.join(" · ") : (geo.isp || "已识别服务器归属地");

  domainText.textContent = data.hostname || "-";

  // CNAME 别名
  if (data.cnames && data.cnames.length > 0) {
    cnameRow.classList.remove("hidden");
    cnameList.innerHTML = "";
    data.cnames.forEach((cn) => {
      const div = document.createElement("div");
      div.className = "cname-item";
      div.textContent = cn;
      cnameList.appendChild(div);
    });
  } else {
    cnameRow.classList.add("hidden");
  }

  // IPv4 与 IPv6
  renderIpList(ipv4List, data.ipv4, data.connectedIp, "无 IPv4 (A) 记录");
  renderIpList(ipv6List, data.ipv6, data.connectedIp, "无 IPv6 (AAAA) 记录");

  // 运营商 / ASN
  const ispParts = [];
  if (geo.isp) ispParts.push(geo.isp);
  if (geo.asn) ispParts.push(geo.asn);
  if (ispParts.length > 0) {
    ispRow.classList.remove("hidden");
    ispText.textContent = ispParts.join(" · ");
  } else {
    ispRow.classList.add("hidden");
  }

  dnsSourceText.textContent = data.dnsProvider || "-";
}

function loadInfo(forceRefresh = false) {
  setLoading(true);
  chrome.runtime.sendMessage(
    { type: forceRefresh ? "REFRESH_TAB_INFO" : "GET_TAB_INFO" },
    (response) => {
      setLoading(false);
      if (chrome.runtime.lastError) {
        renderData({ status: "unsupported", message: "后台服务暂未就绪，请点击刷新重试。" });
        return;
      }
      renderData(response);
    }
  );
}

refreshBtn.addEventListener("click", () => loadInfo(true));
document.addEventListener("DOMContentLoaded", () => loadInfo(false));
