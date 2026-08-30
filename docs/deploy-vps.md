# VPS Docker Compose 部署

该部署方式不依赖 Cloudflare D1、R2、KV 或 Pages，并保留原项目的全部功能：

- GeoSite / GeoIP 规则树与详情
- Surge 与 Egern 文本规则
- sing-box SRS 与 Mihomo MRS
- GeoSite 快速反查、FTS5 综合搜索
- IPv4 / IPv6 / CIDR 反查
- 每日检查上游数据、无变化跳过、有变化时原子更新

## 配置要求

推荐 2 核 CPU、2 GB 内存和至少 10 GB SSD。1 GB 内存建议配置 Swap，并把
`SRS_CONCURRENCY`、`MRS_CONCURRENCY` 设置为 `1`。

需要安装 Docker Engine 和 Docker Compose v2。支持 Linux amd64 与 arm64。

## 启动

```bash
git clone https://github.com/jirong0214/Surge-Geosite-Enhance.git
cd Surge-Geosite-Enhance
cp .env.docker.example .env
```

编辑 `.env`：

```dotenv
PUBLIC_BASE_URL=http://192.168.1.10:8080
HTTP_PORT=8080
DATA_DIR=./data
BUILD_BINARY_RULESETS=true
SRS_CONCURRENCY=2
MRS_CONCURRENCY=2
UPDATE_INTERVAL_SECONDS=86400
KEEP_DATA_VERSIONS=2
```

`PUBLIC_BASE_URL` 必须是浏览器和 Surge 设备能够访问的地址。使用域名和反向代理时，
例如填写 `https://geo.example.com`。

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f init
```

首次启动会完成完整数据构建，通常需要 3～15 分钟。`init` 正常退出后，`api`、
`updater` 和 `web` 会启动。打开：

```text
http://VPS-IP:8080
```

健康检查：

```bash
curl http://127.0.0.1:8080/healthz
```

## 容器结构

- `init`：仅在数据卷为空时初始化，成功后退出。
- `api`：Hono Node 服务，使用只读 SQLite/FTS5 和本地规则文件。
- `updater`：默认每 24 小时检查一次上游哈希；数据未变化时不重建。
- `web`：Nginx 托管 React 前端、反向代理 API，并缓存 GET 响应。

数据默认保存在项目目录的 `./data`，通过 `DATA_DIR` 绑定到容器内的 `/data`。
因此重建容器、更新镜像或执行 `docker compose down` 都不会删除数据，也便于直接备份。
需要放到其他磁盘时，可把 `DATA_DIR` 改成绝对路径，例如 `/srv/geosite-data`；请确保
该目录存在且 Docker 有读写权限。

更新器先在新版本目录构建并验证全部产物，完成后原子切换 `current` 软链接；正在
提供服务的版本不会被半成品覆盖。

## 更新与维护

立即检查并更新一次：

```bash
docker compose run --rm updater node scripts/update-vps-data.mjs
```

更新程序代码和镜像：

```bash
git pull
docker compose up -d --build
```

查看日志和资源：

```bash
docker compose logs -f api updater
docker stats
```

停止服务但保留数据：

```bash
docker compose down
```

数据是宿主机目录，`docker compose down -v` 也不会删除它。需要清理时，请先停止服务，
再手动删除 `DATA_DIR` 指向目录中的内容。

## HTTPS 反向代理

可以让 Caddy、Traefik 或宿主机 Nginx 代理到 `127.0.0.1:8080`。完成后将 `.env` 中
的 `PUBLIC_BASE_URL` 改为 HTTPS 域名，并重建 `api`：

```bash
docker compose up -d --force-recreate api
```

## 关闭可选的二进制规则集

完整功能应保持：

```dotenv
BUILD_BINARY_RULESETS=true
```

如果明确不需要 SRS/MRS，可设置为 `false`，首次构建会更快、磁盘占用更低；对应下载
接口将返回 404。GeoSite、GeoIP、Surge、Egern 和反向搜索不受影响。
