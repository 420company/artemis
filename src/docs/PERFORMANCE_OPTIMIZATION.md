# Artemis 项目性能优化配置

## 性能调优指南

### 1. Node.js 性能优化

#### 1.1 进程管理
```javascript
// 使用 cluster 模块实现多核处理
const cluster = require('cluster');
const os = require('os');

if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  console.log(`主进程 ${process.pid} 正在运行`);
  
  // 衍生工作进程
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`工作进程 ${worker.process.pid} 退出`);
    cluster.fork(); // 重启工作进程
  });
} else {
  // 工作进程代码
  const app = require('./app');
  app.listen(3000);
}
```

#### 1.2 内存优化
```javascript
// 内存使用监控
const os = require('os');

setInterval(() => {
  const memUsage = process.memoryUsage();
  const sysMem = os.totalmem();
  
  console.log('内存使用:', {
    rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
    external: `${Math.round(memUsage.external / 1024 / 1024)} MB`,
    system: `${Math.round(sysMem / 1024 / 1024)} MB`,
    free: `${Math.round(os.freemem() / 1024 / 1024)} MB`
  });
}, 30000);
```

#### 1.3 垃圾回收优化
```javascript
// 垃圾回收调优
const v8 = require('v8');

// 输出垃圾回收信息
v8.setFlagsFromString('--expose_gc');
if (global.gc) {
  setInterval(() => {
    global.gc();
    console.log('强制垃圾回收');
  }, 60000);
}

// 内存分配策略
const maxOldSpaceSize = 4096; // MB
v8.setFlagsFromString(`--max_old_space_size=${maxOldSpaceSize}`);
```

### 2. 服务器性能优化

#### 2.1 连接池配置
```javascript
// 数据库连接池
const { Pool } = require('pg');

const pool = new Pool({
  user: 'username',
  host: 'localhost',
  database: 'artemis',
  password: 'password',
  port: 5432,
  max: 20, // 最大连接数
  idleTimeoutMillis: 30000, // 空闲连接超时
  connectionTimeoutMillis: 2000, // 连接超时
});

// Redis 连接池
const redis = require('redis');

const redisClient = redis.createClient({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: 5,
  enableReadyCheck: true,
  lazyConnect: true,
});
```

#### 2.2 请求优化
```javascript
// 使用 fast-json-stringify 优化 JSON 序列化
const fastJson = require('fast-json-stringify');

const stringify = fastJson({
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    value: { type: 'number' }
  }
});

// 替代 JSON.stringify
app.get('/data', (req, res) => {
  const data = { id: '1', name: 'test', value: 42 };
  res.set('Content-Type', 'application/json');
  res.send(stringify(data));
});
```

### 3. 缓存策略

#### 3.1 响应缓存
```javascript
// 使用 lru-cache
const LRU = require('lru-cache');

const cache = new LRU({
  max: 500, // 最大缓存项目数
  maxSize: 50 * 1024 * 1024, // 最大缓存大小 (50MB)
  ttl: 1000 * 60 * 5, // 缓存过期时间 (5分钟)
  allowStale: false,
});

// 缓存中间件
app.get('/api/cached', (req, res) => {
  const cacheKey = req.originalUrl;
  const cachedResponse = cache.get(cacheKey);
  
  if (cachedResponse) {
    res.set('X-Cache', 'HIT');
    return res.send(cachedResponse);
  }
  
  // 生成响应
  const response = { data: 'fresh' };
  
  cache.set(cacheKey, response);
  res.set('X-Cache', 'MISS');
  res.send(response);
});
```

#### 3.2 Redis 缓存
```javascript
// Redis 缓存
async function getCachedData(key) {
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error('Redis 缓存获取失败:', error);
  }
  return null;
}

async function setCachedData(key, value, ttl = 300) {
  try {
    await redisClient.setex(key, ttl, JSON.stringify(value));
  } catch (error) {
    console.error('Redis 缓存设置失败:', error);
  }
}
```

### 4. 性能监控

#### 4.1 Prometheus 指标
```javascript
// 使用 prom-client
const client = require('prom-client');

// 注册默认指标
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

// 自定义指标
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

// 监控中间件
app.use((req, res, next) => {
  const start = Date.now();
  const end = res.end;
  
  res.end = function(chunk, encoding) {
    const duration = Date.now() - start;
    httpRequestDurationMicroseconds.observe({
      method: req.method,
      route: req.route ? req.route.path : req.originalUrl,
      status_code: res.statusCode
    }, duration / 1000);
    
    end.call(res, chunk, encoding);
  };
  
  next();
});
```

#### 4.2 健康检查
```javascript
// 健康检查端点
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`
    },
    cpu: {
      usage: process.cpuUsage()
    },
    loadAverage: os.loadavg(),
    platform: process.platform,
    nodeVersion: process.version
  };
  
  res.json(health);
});
```

### 5. 数据库优化

#### 5.1 查询优化
```javascript
// 优化的数据库查询
async function getUsersWithPagination(page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  
  const result = await pool.query(`
    SELECT 
      u.id, u.name, u.email, u.role, u.created_at,
      COUNT(m.id) as message_count
    FROM users u
    LEFT JOIN messages m ON u.id = m.user_id
    WHERE u.is_active = true
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT $1 OFFSET $2
  `, [pageSize, offset]);
  
  return result.rows;
}
```

#### 5.2 索引优化
```sql
-- 用户表索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_role ON users(role);

-- 消息表索引
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- 复合索引
CREATE INDEX idx_messages_user_id_created_at ON messages(user_id, created_at DESC);
```

### 6. 代码优化

#### 6.1 异步处理
```javascript
// 优化异步处理
async function processBatchData(data) {
  const batchSize = 10;
  const results = [];
  
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          return await processSingleItem(item);
        } catch (error) {
          console.error('处理项目失败:', item.id, error);
          return null;
        }
      })
    );
    
    results.push(...batchResults.filter(result => result !== null));
  }
  
  return results;
}
```

#### 6.2 错误处理
```javascript
// 优化错误处理
function createErrorHandler() {
  return (error, req, res, next) => {
    console.error('请求失败:', req.originalUrl, error);
    
    const statusCode = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    const message = error.message || '服务器内部错误';
    
    const errorResponse = {
      error: {
        code: statusCode,
        message: message,
        requestId: req.headers['x-request-id'] || Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString()
      }
    };
    
    res.status(statusCode).json(errorResponse);
  };
}
```

### 7. 资源监控

#### 7.1 系统资源监控
```javascript
// 系统资源监控
const si = require('systeminformation');

async function getSystemInfo() {
  const cpu = await si.cpu();
  const memory = await si.mem();
  const disk = await si.fsSize();
  const network = await si.networkInterfaces();
  
  return {
    cpu: {
      brand: cpu.brand,
      cores: cpu.cores,
      speed: cpu.speed,
      usage: await si.currentLoad()
    },
    memory: {
      total: memory.total,
      free: memory.free,
      used: memory.used,
      available: memory.available
    },
    disk: disk.map(d => ({
      mount: d.mount,
      size: d.size,
      used: d.used,
      available: d.available,
      use: d.use
    })),
    network: network.map(n => ({
      iface: n.iface,
      ip: n.ip4 || n.ip6,
      mac: n.mac
    }))
  };
}
```

### 8. 优化建议配置

#### 8.1 PM2 配置
```json
{
  "name": "artemis",
  "script": "dist/index.js",
  "instances": "max",
  "exec_mode": "cluster",
  "watch": false,
  "max_memory_restart": "4G",
  "env": {
    "NODE_ENV": "production"
  },
  "error_file": "./logs/pm2-error.log",
  "out_file": "./logs/pm2-out.log",
  "log_date_format": "YYYY-MM-DD HH:mm:ss"
}
```

#### 8.2 Nginx 配置
```nginx
# /etc/nginx/conf.d/artemis.conf
upstream artemis_backend {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name yourdomain.com;
    
    access_log /var/log/nginx/artemis.access.log;
    error_log /var/log/nginx/artemis.error.log;
    
    location / {
        proxy_pass http://artemis_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
        
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
        proxy_busy_buffers_size 8k;
        proxy_temp_file_write_size 8k;
    }
    
    location /health {
        proxy_pass http://artemis_backend;
        proxy_set_header Host $host;
        access_log off;
        error_log off;
    }
    
    location /metrics {
        proxy_pass http://artemis_backend;
        proxy_set_header Host $host;
        access_log off;
        error_log off;
    }
}
```

### 9. 性能测试

#### 9.1 使用 autocannon 进行压力测试
```bash
# 安装 autocannon
npm install -g autocannon

# 简单测试
autocannon -c 10 -d 30 http://localhost:3000

# 详细测试
autocannon -c 100 -d 60 -t 2 -w 2 -m GET http://localhost:3000
```

#### 9.2 使用 k6 进行负载测试
```javascript
// test.js
import http from 'k6/http';
import { sleep, check } from 'k6';

export let options = {
  vus: 100,
  duration: '60s',
  thresholds: {
    'http_req_duration': ['p(95)<500', 'p(99)<1000']
  }
};

export default function() {
  let res = http.get('http://localhost:3000/api/health');
  
  check(res, {
    'status is 200': r => r.status === 200,
    'response time < 500ms': r => r.timings.duration < 500
  });
  
  sleep(0.1);
}
```

### 10. 优化检查清单

#### 生产环境部署前检查
- [ ] 启用 Gzip 压缩
- [ ] 配置适当的 CORS 设置
- [ ] 启用 HTTPS
- [ ] 配置适当的安全头
- [ ] 启用日志旋转
- [ ] 设置监控和警报
- [ ] 配置错误追踪系统
- [ ] 进行压力测试和负载测试
- [ ] 实施适当的缓存策略
- [ ] 优化数据库查询和索引

通过以上优化策略，Artemis 项目可以在生产环境中获得显著的性能提升，支持高并发场景和稳定运行。