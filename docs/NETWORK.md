# 网络与推送

## GitHub 推送

直连 github.com:443 在本机会被阻断（表现为 `port 443` 连接失败或长时间无响应），
但本机代理 `http://127.0.0.1:7897` 通常可用。推送时带上代理：

```bash
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main
```

若需要带 token（凭据不写入任何文件）：

```bash
git -c http.proxy=http://127.0.0.1:7897 push \
  https://<user>:<token>@github.com/<user>/<repo>.git main
```

## 排查顺序

遇到推送失败时按这个顺序查，能省掉不少猜测：

1. **先确认是不是只有 GitHub 不通**

   ```bash
   curl -sS -o /dev/null -w "%{http_code}" --max-time 8 https://www.baidu.com
   ```

   baidu 通而 github 不通 = GitHub 出口被限制，用代理。
   两个都不通 = 本机网络整体故障，等恢复。

2. **确认代理在监听**

   ```bash
   netstat -ano | findstr :7897
   ```

3. **确认代理能建隧道**（这一步能区分"代理没工作"和"git 用错了方式"）

   ```bash
   node -e "const n=require('net').connect(7897,'127.0.0.1',()=>{n.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n')});n.on('data',d=>{console.log(d.toString().split('\r\n')[0]);process.exit(0)});setTimeout(()=>process.exit(0),8000)"
   ```

   期望输出 `HTTP/1.1 200 Connection established`。

4. **注意 curl 的误导性报错**

   本机 curl 走代理时可能报 `curl: (23) client returned ERROR on write`，
   看起来像网络断了，其实 curl 自身有问题。改用 Node 的 fetch 复测更可靠。

## 代理探测结论

2026-10-21 实测：

| 通道 | 结果 |
|---|---|
| 直连 github.com:443 | ✗ 超时 |
| 直连 github.com:22 | ✗ ECONNRESET |
| 代理 CONNECT github.com:443 | ✓ 200 Connection established |
| 代理 + TLS 完整请求 | ✓ HTTP/1.1 200 OK（760ms） |
| 直连 www.baidu.com | ✓ 200 |

即：网络本身正常，GitHub 的直连出口被挡，代理可用。
