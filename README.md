---
layout: post
title: "个人微信小程序后台Ubuntu端部署+支付"
subtitle: ""
author: "..."
header-img: "img/tu/home-blue.jpg"
header-mask: 0.4
tags:
- 小程序
- Ubuntu
---

# wxminiapp-server 部署运维完整教程

项目地址[https://github.com/2091k/wxminiapp-server](https://github.com/2091k/wxminiapp-server)

> 适用环境：Ubuntu 20.04+（aarch64 / x86_64）· Node.js 22.5+ · systemd
> 本文档对应服务器路径：`/opt/wxminiapp-server`，服务地址 `http://<服务器IP>:8787`

---

## 一、目录文件说明（/opt/wxminiapp-server/ 下每个文件）

| 文件/目录 | 作用 | 能否删除 |
|---|---|---|
| `server.mjs` | **服务入口**。把 Worker 代码包装成普通 Node HTTP 服务；读取 `.env`、注入 SQLite 数据层、启动 HTTP 监听。 | ❌ 必需 |
| `db.mjs` | **SQLite 数据层**。用 Node 内置 `node:sqlite` 建表并实现所有数据读写（users / orders / products / logs / counters），等价于本地版 Cloudflare D1。 | ❌ 必需 |
| `src/index.js` | **业务主代码**（微信小程序后端 + /admin 后台）。包含全部路由、JWT、虚拟支付签名、后台页面。 | ❌ 必需 |
| `.env` | **运行配置**。端口、账号密码、密钥、微信/支付参数（见第五节）。 | ❌ 必需 |
| `data/` | **数据库目录**。内含 `wxminiapp.db`（主库）、`wxminiapp.db-shm`、`wxminiapp.db-wal`（SQLite 日志文件）。 | ❌ 必需，备份对象 |
| `run.log` | 运行日志（nohup/setsid 方式启动时写入）。 | 可删，会自动重建 |
| `README.md` | 项目说明文档。 | ✅ 可删 |
| `tools/` | 开发校验/迁移工具（check-admin.js 等）。 | ✅ 运行不需要 |
| `schema.sql` | 旧版 SQL 说明（已废弃）。 | ✅ 可删 |
| `wrangler.toml` | Cloudflare Workers 部署配置（仅 CF 云端用）。 | ✅ 本地不需要 |

**文件依赖关系**：`server.mjs` → 读 `.env` + `db.mjs` + `src/index.js`（三者为运行最小集）。

---

## 二、环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Ubuntu 20.04+ / Debian 系 | 其他 Linux 也行 |
| CPU 架构 | aarch64（ARM64）或 x86_64 | 下载对应 Node 包 |
| Node.js | **22.5+**（需 `--experimental-sqlite`）或 23.4+/24+（免参数） | 本项目零 npm 依赖 |
| systemd | 有（`ps -p 1` 显示 systemd） | 开机自启需要 |
| 内存/磁盘 | ≥512MB 内存、≥100MB 磁盘 | 实测 646MB 内存可跑 |

---

## 三、安装 Node.js（以 aarch64 / Ubuntu 20.04 为例）

### 3.1 检查环境

```bash
node --version        # 已装则跳过本节
uname -m              # aarch64 / x86_64
```

### 3.2 下载官方二进制（自动匹配最新 v22 LTS 的 ARM64 包）

```bash
cd /tmp
curl -sL -o node.tar.xz "https://nodejs.org/dist/latest-v22.x/$(curl -s https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -oP 'node-v[0-9.]+-linux-arm64\.tar\.xz' | head -1)"
```

> x86_64 机器把上面 URL 里的 `linux-arm64` 换成 `linux-x64`。

### 3.3 解压安装到 /usr/local

```bash
tar -xJf node.tar.xz -C /usr/local --strip-components=1
```

### 3.4 验证

```bash
node --version   # 应显示 v22.x.x
npm --version    # 应显示 10.x
```

> 本项目**零 npm 依赖**，不需要 `npm install`。

### 3.5 重要：如果你之前用 nvm 安装了 Node.js

如果你是通过 `nvm install` 装的 Node（而不是上面 3.2~3.3 的官方二进制解压方式），**后面 systemd 开机自启会找不到 node**，必须注意：

**先查 node 实际路径：**
```bash
which node
# 或者如果 which 没输出（nvm 环境未加载），用：
find /root/.nvm -name 'node' -type f 2>/dev/null
# 典型输出：/root/.nvm/versions/node/v22.23.3/bin/node
```

> nvm 安装的 node 路径在 `/root/.nvm/versions/node/<版本号>/bin/node`，**不是** `/usr/local/bin/node`。
> systemd 不加载用户的 nvm 环境变量，直接写 `node` 或写 `/usr/local/bin/node` 都会报 `203/EXEC` 错误。

**两种解决方式（任选其一）：**

方式一：改 systemd 服务文件里的 ExecStart 路径（推荐）
```bash
# 把下面命令里的路径替换成你 which node 查到的实际路径
sed -i 's|/usr/local/bin/node|/root/.nvm/versions/node/v22.23.3/bin/node|' /etc/systemd/system/wxminiapp.service
systemctl daemon-reload
```

方式二：做软链接到 /usr/local/bin
```bash
ln -s /root/.nvm/versions/node/v22.23.3/bin/node /usr/local/bin/node
ln -s /root/.nvm/versions/node/v22.23.3/bin/npm /usr/local/bin/npm
```

> **建议**：如果是全新部署，优先用上面 3.2~3.3 的官方二进制解压方式装到 `/usr/local`，省事不踩坑。已经用 nvm 装了也没关系，按上面改路径即可。

---

## 四、部署项目文件

### 4.1 创建目录

```bash
mkdir -p /opt/wxminiapp-server/src /opt/wxminiapp-server/data
```

### 4.2 上传文件（本地 → 服务器）

方式一：scp（在**本地**电脑执行）

```bash
scp server.mjs db.mjs root@<服务器IP>:/opt/wxminiapp-server/
scp src/index.js root@<服务器IP>:/opt/wxminiapp-server/src/
```

方式二：sftp（在**本地**电脑执行）

```bash
sftp root@<服务器IP>
cd /opt/wxminiapp-server
put server.mjs
put db.mjs
cd src
put src/index.js
```

### 4.3 语法检查（可选但建议）

```bash
cd /opt/wxminiapp-server
node --check server.mjs && node --check db.mjs && node --check src/index.js && echo ALL OK
```

---

## 五、配置 .env（关键！）

### 5.1 创建 .env

`=` 后面写的是**要替换成的值**，照着填；不替换就等于配了错值（登录/取号会失败）。

```bash
cd /opt/wxminiapp-server
cat > .env <<'EOF'
# 基础运行（一般不用改）
PORT=8787
DB_PATH=./data/wxminiapp.db
APP_NAME=我的小程序
ADMIN_PREFIX=admin
JWT_EXPIRE=2592000
ADMIN_PAGE_SIZE=20
KV_MAX_SCAN=1000
XPAY_MOCK=1

# 后台登录
ADMIN_USERNAME=admin
ADMIN_PASSWORD=改成你自己的后台密码
JWT_SECRET=openssl rand -hex 24 生成后粘贴过来

# 微信登录（必填，否则小程序登录不了）
WX_APPID=小程序AppID，MP→开发管理→开发设置
WX_SECRET=小程序AppSecret，同页面，只显示一次

# 虚拟支付（不填就只能用测试模式，不扣款）
XPAY_OFFER_ID=虚拟支付OfferID，MP→虚拟支付→基础配置
XPAY_APP_KEY=虚拟支付AppKey，同页面
# 微信「消息推送」里的 Token(令牌)，发货推送的接入验证要用（详见第十二节）
XPAY_NOTIFY_TOKEN=自己定3-32位英文数字，必须与MP后台消息推送里的Token一字不差
# 旧版可选的报文签名校验（只认请求头 x-signature），新版不需要，留空
XPAY_NOTIFY_SIGN_KEY=

# 序列号后台（Cloudflare Worker）
# 生成 API_TOKEN（48 位，两边要填一样）：
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
BTKEY_API_BASE=https://你的Worker域名，带https结尾不要斜杠
BTKEY_API_TOKEN=上面命令生成的那串，Worker那边也要填同一个
SERIAL_CATEGORY=wxminiapp
SERIAL_WISH_COST=每次取号扣多少愿望，留空=10
EOF
```

### 5.2 生成随机密钥

#### ① JWT_SECRET（后台登录签名用）

```bash
openssl rand -hex 24 | head -c 48
# 或者用 node（输出 48 位十六进制）
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

#### ② 后台登录密码（自己定，别用 admin/123456）

```bash
openssl rand -base64 9 | tr -d '/+=' | head -c 12
```

#### ③ API_TOKEN（服务器 ⇄ 序列号后台 之间的通信令牌）

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

输出形如 `7f3a9c1e5b...`（48 位十六进制）。这条命令跑一次，拿到的那串字符要**同时填到两个地方**，而且必须一字不差：

| 填在哪 | 位置 | 变量名 |
|---|---|---|
| 服务器 A（本项目） | `/opt/wxminiapp-server/.env` | `BTKEY_API_TOKEN=刚生成的串` |
| 序列号后台 B（Cloudflare Worker） | Cloudflare 后台 → 你的 Worker → **设置 → 变量和机密** → 添加**加密**类型 | `API_TOKEN=刚生成的串` |

> 两边不一致 = 取号报 `401 unauthorized`；只填一边 = 取号报「后台还没配置序列号服务」。
> 改完两边都要重启/重新部署才生效。
>
> 也可以用 openssl 生成（等价，随便挑一个）：`openssl rand -hex 24`


### 5.3 逐项怎么填（重点看「必填」和「去哪拿」）

#### 基础运行（一般不用改）

| 变量 | 必填 | 填什么 / 去哪拿 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 `8787`。Nginx 反代到这里，改动后 Nginx 也要跟着改 |
| `DB_PATH` | 否 | SQLite 文件路径，默认 `./data/wxminiapp.db`。首次启动会自动建库建表 |
| `APP_NAME` | 否 | 后台标题、页面显示名，随便填 |
| `ADMIN_PREFIX` | 否 | 后台路径前缀：填 `admin` → 后台地址是 `https://你的域名/admin` |
| `JWT_EXPIRE` | 否 | 登录 token 有效期（秒），`2592000` = 30 天 |
| `ADMIN_PAGE_SIZE` | 否 | 后台列表每页条数，默认 20 |
| `KV_MAX_SCAN` | 否 | 后台一次最多扫多少用户，默认 1000 |

#### 后台登录（必填，别用默认值上线）

| 变量 | 必填 | 填什么 / 去哪拿 |
|---|---|---|
| `ADMIN_USERNAME` | ✅ | 后台账号，自己定 |
| `ADMIN_PASSWORD` | ✅ | 后台密码，自己定强密码（别用 `admin`/`123456`） |
| `JWT_SECRET` | ✅ | 签名密钥，**≥40 位随机串**。生成：`openssl rand -hex 24`。泄漏=别人能伪造任何人的登录态 |

#### 微信登录（✅ 必填，否则小程序点了登录直接失败）

| 变量 | 必填 | 填什么 / 去哪拿 |
|---|---|---|
| `WX_APPID` | ✅ | 小程序 AppID。**微信公众平台 mp.weixin.qq.com → 开发管理 → 开发设置 → 开发者ID → AppID(小程序ID)**，形如 `wx1234567890abcdef` |
| `WX_SECRET` | ✅ | 小程序 AppSecret。同一页面的 **AppSecret**，点「生成/重置」后完整显示一次，**当场复制保存**。⚠️ 别填成公众号 / 商户号 / 云开发的密钥 |

> 这两个不填的话：小程序登录会报「微信登录失败」，绑手机号、取号、插座验证码全都用不了。

#### 虚拟支付（真收款才需要）

| 变量 | 必填 | 填什么 / 去哪拿 |
|---|---|---|
| `XPAY_MOCK` | ✅ | `1` = 测试模式（买什么都不扣钱，只用于自测）；**正式上线必须改成 `0`** |
| `XPAY_OFFER_ID` | 真支付 | 虚拟支付 **OfferID**：微信公众平台 → 虚拟支付 → 基础配置 |
| `XPAY_APP_KEY` | 真支付 | 虚拟支付 **AppKey**：同上页面（下单签名用） |
| `XPAY_NOTIFY_TOKEN` | 真支付 | 微信 **消息推送**里的 **Token(令牌)**：MP → 开发管理 → 消息推送 → Token。3–32 位英文/数字，必须与后台**一字不差**，否则接入验证失败（见第十二节） |
| `XPAY_NOTIFY_SIGN_KEY` | 否 | 旧版可选：只对带 `x-signature` 请求头的报文做 HMAC 校验。新版微信推送不带这个头，**留空**即可；它**不是**消息推送里的 Token |

> 只填 `XPAY_MOCK=1` 时，购买按钮可以走通但**不扣款**，适合提交审核前自测。

#### 序列号后台（要发序列号就必须填）

| 变量 | 必填 | 填什么 / 去哪拿 |
|---|---|---|
| `BTKEY_API_BASE` | ✅ | 序列号后台（Cloudflare Worker）的**完整域名**，带 `https://`，结尾不要 `/`。例：`https://btkey.你的域名.com` |
| `BTKEY_API_TOKEN` | ✅ | 服务器与序列号后台之间的通信令牌。**生成**：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`（48 位）。**同一个值填两处**：① 本项目 `.env` 的 `BTKEY_API_TOKEN`；② Cloudflare Worker → 设置 → 变量和机密 → 添加 `API_TOKEN`（加密类型）。**两边必须一字不差**，否则取号报 `401 unauthorized` |
| `SERIAL_CATEGORY` | 否 | 固定从哪个分类发号，默认 `wxminiapp`。必须与后台「分类管理」里的分类名**完全一致**（大小写、空格都算） |
| `SERIAL_WISH_COST` | 否 | 非首次取号扣多少愿望，留空 = 10 |

> 不填 `BTKEY_API_BASE` / `BTKEY_API_TOKEN`：取号会直接返回「后台还没配置序列号服务」，不会扣愿望。

### 5.4 填完自检（30 秒）

```bash
# 1) 看配置是否被正确读进来（不应出现「未配置」）
cd /opt/wxminiapp-server
grep -E '^(WX_APPID|WX_SECRET|BTKEY_API_BASE|BTKEY_API_TOKEN)=' .env

# 2) 重启服务
systemctl restart wxminiapp-server 2>/dev/null || pkill -f "server.mjs" && sleep 1 && cd /opt/wxminiapp-server && nohup node --experimental-sqlite server.mjs > app.log 2>&1 &

# 3) 探活：应当返回 {"ok":true,...}
curl -s http://127.0.0.1:8787/health
```

小程序端对应的自检顺序：

```
① 「我的」→ 微信一键登录        → 能登录（说明 WX_APPID / WX_SECRET 对了）
② 绑定手机号                    → 提示已保存
③ 序列号取号 → 免费取号          → 能出号（说明 BTKEY_* + SERIAL_CATEGORY 对了）
④ 插座验证码 → 生成 1 个         → 能出 6 位码（会扣 1 个愿望）
```

### 5.5 常见报错对照

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 小程序登录报「微信登录失败」 | `WX_APPID` / `WX_SECRET` 空或填错 | 检查这两项，AppSecret 是否复制完整 |
| 取号报「后台还没配置序列号服务」 | `BTKEY_API_BASE` / `BTKEY_API_TOKEN` 为空 | 填上 Worker 域名和 API_TOKEN |
| 取号报 `401 unauthorized` | `BTKEY_API_TOKEN` 与 Worker 里的不一致 | 两边改成同一个值 |
| 取号报 `out_of_stock` | 分类里没号了，或 `SERIAL_CATEGORY` 名字不对 | 后台导号；核对分类名（用 `check-deploy.mjs` 体检） |
| 购买后没到账（订单一直 `pending`） | 微信「消息推送」没启用，或后台 Token 与 `XPAY_NOTIFY_TOKEN` 不一致 | 按第十二节配置；后台日志搜 `xpay_notify` |
| 消息推送点「提交」报「服务器地址验证失败」 | 服务端不支持 GET `echostr` 验证，或 Token 没传进服务（server.mjs 白名单） | 升级 `src/index.js` + `server.mjs`，按 12.4 自检 |
| 后台打不开 / 一直跳登录 | `ADMIN_PREFIX` 改了但访问路径没改 | 按新前缀访问，如 `/abc` |
| 后台登录后立刻掉线 | `JWT_SECRET` 被改过（签发和校验不一致） | 固定 JWT_SECRET，改完所有人需重新登录 |

> 改完 `.env` 后**必须重启服务**才生效（systemd：`systemctl restart wxminiapp-server`）。

---

## 六、启动与验证

### 6.1 前台启动（测试用）

```bash
cd /opt/wxminiapp-server
node --experimental-sqlite server.mjs
```

看到 `wxminiapp-server on http://0.0.0.0:8787` 即成功，Ctrl+C 停止。

### 6.2 后台常驻启动（推荐，SSH 断开不掉）

```bash
cd /opt/wxminiapp-server
setsid node --experimental-sqlite server.mjs > run.log 2>&1 < /dev/null &
```

### 6.3 验证

```bash
curl http://127.0.0.1:8787/health
# 期望：{"ok":true,"app":"我的小程序","xpay_mock":true}

curl http://<服务器IP>:8787/health    # 内网/公网 IP 验证
curl -o /dev/null -w '%{http_code}\n' http://<服务器IP>:8787/admin   # 期望 302
```

---

## 七、停止 / 重启服务

> **先选一种管理方式，不要混用**：
> - **未配 systemd**（当前服务器状态）：用本节 setsid 方式；
> - **已按第八节配好 systemd**：日常一律用 `systemctl restart/stop wxminiapp`，回到本节用 setsid 会双进程抢端口。

### 7.1 停止服务

方式一：按 PID

```bash
ps aux | grep server.mjs | grep -v grep     # 找到 PID
kill <PID>
```

方式二：按名字（推荐）

```bash
pkill -f 'node --experimental-sqlite server.mjs'
```

方式三：systemd（如果已按第八节配置）

```bash
systemctl stop wxminiapp
```

### 7.2 重启服务

```bash
pkill -f 'node --experimental-sqlite server.mjs'; sleep 1
cd /opt/wxminiapp-server && setsid node --experimental-sqlite server.mjs > run.log 2>&1 < /dev/null &
sleep 2 && curl -s http://127.0.0.1:8787/health
```

> **注意**：`node --experimental-sqlite server.mjs` 是 Node 22 的固定写法（SQLite 实验性开关）；Node 24+ 可去掉该参数。

---

## 八、开机自启动（systemd）

> **前提**：服务器需有 systemd（`ps -p 1` 显示 `systemd` 即可，Ubuntu 20.04 默认有）。
> **当前服务器状态提醒**：本机目前服务仍是 `setsid` 方式运行（无开机自启）。下面的步骤是"切换 + 配置"的完整流程，照做后服务由 systemd 托管：开机自动拉起、崩溃 3 秒后自动重启。

### 8.1 创建服务文件

```bash
cat > /etc/systemd/system/wxminiapp.service <<'EOF'
[Unit]
Description=wxminiapp-server (WeChat MiniApp backend)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wxminiapp-server
ExecStart=/usr/local/bin/node --experimental-sqlite server.mjs
Restart=always
RestartSec=3
EnvironmentFile=/opt/wxminiapp-server/.env
StandardOutput=append:/opt/wxminiapp-server/run.log
StandardError=append:/opt/wxminiapp-server/run.log

[Install]
WantedBy=multi-user.target
EOF
```

各字段说明：

| 字段 | 含义 |
|---|---|
| `ExecStart` | 启动命令。**必须写 Node 绝对路径**，路径用 `which node` 查出来的实际值填，不要照抄下面的 `/usr/local/bin/node`：<br>• 官方二进制解压装的 → 一般是 `/usr/local/bin/node`<br>• nvm 装的 → 一般是 `/root/.nvm/versions/node/vXX.X.X/bin/node`（见 3.5 节）<br>Node 22 固定带 `--experimental-sqlite`，Node 24+ 可去掉 |
| `WorkingDirectory` | 工作目录，必须是 `/opt/wxminiapp-server`（`DB_PATH=./data/...` 相对路径依赖它） |
| `EnvironmentFile` | 自动注入 `.env` 全部变量（PORT/WX_APPID/JWT_SECRET 等），与手动 export 等效 |
| `Restart=always` + `RestartSec=3` | 进程退出/崩溃后 3 秒自动拉起 |
| `StandardOutput/Error` | 日志追加写入 `run.log`，与 setsid 方式日志一致 |

> `.env` 里不要给值加引号（systemd 不支持引号包裹），本项目生成格式已满足。

### 8.2 先停掉旧的 setsid 进程（避免端口冲突）

```bash
pkill -f 'node --experimental-sqlite server.mjs'; sleep 1
ss -tlnp | grep 8787 || echo "PORT 8787 FREE"
```

> 如果不先停旧进程，`systemctl start` 会因端口被占而失败（8787 已被 setsid 进程持有）。

### 8.3 启用并启动

```bash
systemctl daemon-reload
systemctl enable wxminiapp        # 设置开机自启（重启后自动拉起）
systemctl start wxminiapp         # 立即启动
```

### 8.4 验证

```bash
systemctl status wxminiapp          # 期望：active (running)
systemctl is-enabled wxminiapp      # 期望：enabled
curl -s http://127.0.0.1:8787/health
# 期望：{"ok":true,"app":"我的小程序","xpay_mock":true}
journalctl -u wxminiapp -n 20       # 看 systemd 视角的启动日志
```

### 8.5 日常管理命令（systemd 方式）

```bash
systemctl restart wxminiapp   # 重启（改代码/改 .env 后用它）
systemctl stop wxminiapp      # 停止
systemctl disable wxminiapp   # 取消开机自启（服务仍可手动 start）
systemctl status wxminiapp    # 查看运行状态
journalctl -u wxminiapp -f    # 实时跟踪日志
```

> **注意**：一旦交给 systemd 管理，日常重启请用 `systemctl restart wxminiapp`，**不要再混用 setsid 启动**（会双进程抢端口）。

### 8.6 排错

| 现象 | 处理 |
|---|---|
| `systemctl start` 报端口占用 | 先 `pkill -f 'node --experimental-sqlite server.mjs'` 再 start |
| start 后立即变 `failed` | `journalctl -u wxminiapp -n 30` 看报错（多为语法错误/路径错误） |
| `status=203/EXEC` 或日志报 `No such file or directory` | **node 路径不对**。`which node` 查实际路径，改服务文件里的 ExecStart（见 3.5 节） |
| 启动成功但改 .env 不生效 | 必须 `systemctl restart wxminiapp` |
| 想完全移除 systemd 服务 | `systemctl disable --now wxminiapp && rm /etc/systemd/system/wxminiapp.service` |

---

## 九、修改端口 / 新增 API

### 9.1 修改端口

改 `.env` 里的 `PORT`：

```bash
sed -i 's/^PORT=.*/PORT=9000/' /opt/wxminiapp-server/.env
systemctl restart wxminiapp        # 或按 7.2 手动重启
```

> 监听地址已固定在 `0.0.0.0`（server.mjs 内），改端口即所有网卡生效。注意云服务器需在安全组/防火墙放行新端口。

### 9.2 新增 API 接口（示例：加一个 GET /api/hello）

编辑 `src/index.js`，**第 1 步**：在路由区（约第 120 行 `/health` 附近）加一行路由：

```js
  if (p === '/api/hello' && request.method === 'GET') return apiHello(request, env);
```

**第 2 步**：在文件里任意位置（建议放在其他 api 函数旁）加处理函数：

```js
async function apiHello(request, env) {
  return json({ ok: true, msg: 'hello from wxminiapp-server', app: env.APP_NAME }, 200);
}
```

**第 3 步**：语法检查 + 重启 + 验证：

```bash
node --check src/index.js && echo SYNTAX OK
pkill -f 'node --experimental-sqlite server.mjs'; sleep 1
cd /opt/wxminiapp-server && setsid node --experimental-sqlite server.mjs > run.log 2>&1 < /dev/null &
curl http://127.0.0.1:8787/api/hello
# 期望：{"ok":true,"msg":"hello from wxminiapp-server","app":"我的小程序"}
```

> 若用 systemd 管理，重启改为 `systemctl restart wxminiapp`。

### 9.3 新增 POST 接口（带 JSON 请求体示例）

路由行：

```js
  if (p === '/api/echo' && request.method === 'POST') return apiEcho(request, env);
```

处理函数：

```js
async function apiEcho(request, env) {
  const body = await request.json().catch(() => ({}));
  return json({ ok: true, received: body }, 200);
}
```

测试：

```bash
curl -X POST http://127.0.0.1:8787/api/echo -H 'Content-Type: application/json' -d '{"a":1}'
```

---

## 十、常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 内网 IP 访问不通 | 监听只绑 127.0.0.1 | server.mjs 中 `listen` 地址改为 `'0.0.0.0'`，重启 |
| `SyntaxError` | Node 版本太旧 | 装 Node 22.5+ |
| `node:sqlite` 找不到 | 缺 `--experimental-sqlite` | 用 `node --experimental-sqlite server.mjs` |
| 端口被占用 | 有旧进程 | `pkill -f server.mjs` 后重启 |
| 后台改配置不生效 | 未重启 | 重启服务（见第七节） |
| 服务进程莫名消失 | SSH 会话回收 | 用 `setsid` 启动，或用 systemd（第八节） |
| `/api/xpay/*` 返回 unauthorized | 需登录态/token | 属正常鉴权，先 `/api/auth/login` |

---

## 十一、备份与升级

### 备份数据库

```bash
cp /opt/wxminiapp-server/data/wxminiapp.db /opt/backup-$(date +%F).db
```

### 定时备份（crontab）

```bash
crontab -e
# 每天 3 点备份，保留 7 天
0 3 * * * cp /opt/wxminiapp-server/data/wxminiapp.db /opt/backup/wxminiapp-$(date +\%F).db && find /opt/backup -name 'wxminiapp-*.db' -mtime +7 -delete
```

### 升级代码

```bash
# 重新上传 server.mjs / db.mjs / src/index.js 后：
cp src/index.js /tmp/check.mjs && node --check /tmp/check.mjs && systemctl restart wxminiapp
```

> `src/index.js` 是 ESM 语法但扩展名是 `.js`，直接 `node --check src/index.js` 会被当成 CommonJS 报错，所以先复制成 `.mjs` 再检查。

---

## 十二、微信「消息推送」与虚拟支付发货推送（自动发货）

### 12.1 这一节解决什么问题

**支付成功 ≠ 已经发货。** 发序列号 / 生成插座验证码的触发点是微信推过来的**发货推送**（事件 `xpay_goods_deliver_notify`），而微信只有在 MP 后台【开发】-【开发管理】-【消息推送】**启用并配通**之后，才会把这条消息推给你的服务器。

两者是同一份配置：虚拟支付 → 道具管理 → 「发货推送配置」卡片上的「前往配置」按钮，跳转的就是【开发】-【开发管理】-【消息推送】。

没配通时的典型表现：

| 现象 | 数据特征 |
|---|---|
| 用户付款成功，但没发号/没出码 | 订单 `status = pending`、`deliver_status = pending` |
| 后台点「重新发号」立刻正常 | `logs` 里只有 `order_create` 和 `admin_redeliver`，**没有任何 `xpay_notify_*`** |
| 推送从没到过 | 订单 `wxOrderId` 为 `null`（推送到了会写入这个字段） |

### 12.2 服务端需要支持的两件事（当前代码已实现）

| 步骤 | 微信的动作 | 服务端实现 |
|---|---|---|
| ① URL 接入验证 | 后台点「提交」时先发 **GET** `?signature=&timestamp=&nonce=&echostr=`，要求原样返回 `echostr` | `src/index.js` 的 `apiNotifyVerify()`：`sha1(字典序(token,timestamp,nonce))` 与 `signature` 比对，通过则返回纯文本 `echostr` |
| ② 发货推送 | 支付成功后 **POST** XML/JSON 到同一个 URL | `src/index.js` 的 `apiNotify()`：解析报文 → 按 `OutTradeNo` / `MchOrderNo` 查单 → `deliverOrder()` 发货 → 回 `<xml><ErrCode>0</ErrCode>…</xml>`（JSON 推 JSON，XML 推 XML） |

> 微信对推送**最多重试 15 次**（间隔 2/4/8/16…秒），且要求 3 秒内应答；所以发货失败要尽快返回，别在回调里做耗时操作。

⚠️ **最大的坑：`server.mjs` 是白名单传参。** 它把环境变量一个个显式搬进 `const env = {...}` 再交给业务代码，**不是**整个 `process.env` 透传。所以新增任何变量时，除了写 `.env`，还必须同时在 `server.mjs` 的 `env` 对象里加一行：

```js
  // 微信「消息推送」里的 Token(令牌)：GET 接入验证（echostr）用它算 sha1 签名
  XPAY_NOTIFY_TOKEN: process.env.XPAY_NOTIFY_TOKEN || '',
```

漏了这一步的症状：`.env` 里明明有值，接口却返回 `503 notify token not configured`。

### 12.3 配置步骤（照着做）

**① 服务器侧**

```bash
cd /opt/wxminiapp-server
# 1) .env 末尾加一行（不能有空格/引号，且建议文件以换行结尾）
echo 'XPAY_NOTIFY_TOKEN=自己定的3-32位英文数字' >> .env
# 2) 确认服务已升级到含 apiNotifyVerify 的版本
grep -c 'apiNotifyVerify' src/index.js      # 应输出 ≥1
grep -n 'XPAY_NOTIFY_TOKEN' server.mjs      # 应能看到白名单那一行
# 3) 重启（改 .env 必须重启才生效）
systemctl restart wxminiapp
```

**② 微信侧（MP 后台）**

| 字段 | 填什么 |
|---|---|
| URL(服务器地址) | `https://你的域名/api/xpay/notify`（必须 https/80/443，公网可达） |
| Token(令牌) | 与 `.env` 的 `XPAY_NOTIFY_TOKEN` **完全一致**（3–32 位英文/数字） |
| EncodingAESKey | 点「随机生成」即可；**明文模式下用不到**，以后切安全模式才需要 |
| 消息加密方式 | **明文模式**（当前代码只支持明文；安全模式是密文，会被判 `malformed`） |
| 数据格式 | XML 或 JSON 都行，代码两种都认（推荐 XML） |

点「提交」，页面不再报「服务器地址验证失败」即为配置成功；随后到 虚拟支付 → 道具管理 → 「发货推送配置」卡片里做一次 **调试/模拟推送**。

> 若你用的是 Cloudflare Tunnel / Nginx 反代，注意不要拦截这个路径，也不要改写成别的地址；微信只会推你填的这个 URL。

### 12.4 自检命令（只读，不改数据）

```bash
cd /opt/wxminiapp-server
PORT=$(grep '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
TOKEN=$(grep '^XPAY_NOTIFY_TOKEN=' .env | cut -d= -f2)

# ① 模拟微信的 URL 接入验证：期望原样输出 HELLO（不是 503/403）
TS=1700000000; NONCE=123
SIG=$(printf '%s\n' "$TOKEN" "$TS" "$NONCE" | sort | tr -d '\n' | sha1sum | awk '{print $1}')
curl -s "http://127.0.0.1:$PORT/api/xpay/notify?signature=$SIG&timestamp=$TS&nonce=$NONCE&echostr=HELLO"; echo

# ② 模拟一条明文 XML 推送（假单号）：期望 <ErrCode>0</ErrCode>，日志里多一条 xpay_notify_unknown_order
curl -s -X POST "http://127.0.0.1:$PORT/api/xpay/notify" -H 'Content-Type: text/xml' \
  --data-binary '<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event><OutTradeNo><![CDATA[TEST_NO]]></OutTradeNo><WeChatPayInfo><![CDATA[{"MchOrderNo":"TEST_MCH"}]]></WeChatPayInfo></xml>'; echo
```

核对数据库（服务器**没装 sqlite3**，用 Node 查）：

```bash
cd /opt/wxminiapp-server
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./data/wxminiapp.db', { readOnly: true });
console.log('== 最近订单 ==');
for (const o of db.prepare(\"select id,status,deliver_status,wxOrderId,datetime(createdAt,'unixepoch','+8 hours') ct from orders order by createdAt desc limit 5\").all()) console.log(o);
console.log('== 推送相关日志 ==');
for (const l of db.prepare(\"select action,detail,datetime(created_at,'unixepoch','+8 hours') t from logs where action like 'xpay%' order by id desc limit 20\").all()) console.log(l);
"
```

### 12.5 排查对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 提交时报「服务器地址验证失败」 | 服务端没有 GET `echostr` 逻辑（旧代码），或 Token 没进 `env` | 升级 `src/index.js` + `server.mjs`；按 12.4 ①自检 |
| 自检① 返回 `503 notify token not configured` | `server.mjs` 白名单没加该变量，或 `.env` 改了没重启 | 见 12.2 的⚠️ |
| 自检① 返回 `403 bad signature` | `XPAY_NOTIFY_TOKEN` 与 MP 后台 Token 不一致 | 两边改成同一个串并重启 |
| 自检① 返回 `404 not_found` | 线上跑的还是旧 `src/index.js` | 重新上传、重启 |
| 日志 `xpay_notify_malformed`，detail 里含 `Encrypt` | 后台选了「安全模式」，代码不解密 | 把加密方式改「明文模式」 |
| 日志 `xpay_notify_unknown_order` | 推送单号在本库查不到（改过库 / 多环境混用） | 核对 `OutTradeNo`；注意此时代码回 `ErrCode=0`，微信**不会重试** |
| 回 `ErrCode=0` 但没发货 | 订单已是 `delivered`（幂等），或商品号不符被拒 | 查 `logs` 里的 `xpay_product_mismatch` |
| 付款后要等很久才到账 | 推送丢失，靠人工补发 | 配 12.6 的兜底任务 |

### 12.6 兜底：主动查单（推送丢了也能自动补发）

`GET /api/xpay/tasks?ckey=<JWT_SECRET前16位>` 会扫描「超过 2 分钟仍未发货、且创建不超过 24 小时」的订单，逐个调 `query_order`，查到已支付就补发。

```bash
# 手动跑一次
curl -s "http://127.0.0.1:$PORT/api/xpay/tasks?ckey=$(grep '^JWT_SECRET=' .env | cut -d= -f2 | cut -c1-16)"
```

建议挂定时任务（每 5 分钟）：

```bash
crontab -e
*/5 * * * * curl -s "https://你的域名/api/xpay/tasks?ckey=你的JWT_SECRET前16位" >/dev/null
```

> 微信官方要求「发货推送分支」和「发货轮询分支」**至少实现一个**。本项目两条都上：推送到得快，查单兜住丢推送的情况。
> 小程序端 `utils/xpay.js` 的 `pollOrder()` 只是读本地订单状态，**不会**主动去微信查单，所以别指望它自愈。

### 12.7 上线后验证清单

```
① MP 后台消息推送 → 状态「已启用」，Token 与 .env 一致
② 12.4 ① 输出 HELLO
③ 虚拟支付 → 道具管理 → 发货推送配置 → 调试，后台出现 xpay_notify_verify_ok
④ 真机付 1 单：订单 1~3 秒内 status=delivered、deliver_status=issued、wxOrderId 非空
⑤ logs 里出现 xpay_deliver（而不是只有 admin_redeliver）
```
