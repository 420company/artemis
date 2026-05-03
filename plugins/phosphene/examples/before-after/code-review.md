# Before vs After — Code Review

**Task:** Review the following auth middleware for problems.

```typescript
async function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    const cached = await redis.get(`user:${decoded.id}`);
    if (cached) {
      req.userProfile = JSON.parse(cached);
    } else {
      req.userProfile = await db.users.findOne({ id: decoded.id });
      await redis.set(`user:${decoded.id}`, JSON.stringify(req.userProfile));
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

---

## Clear (baseline)

这段代码有几个问题：

1. `authorization` header 通常格式是 `Bearer <token>`，需要先 split 取第二部分
2. Redis cache 没有设置过期时间，用户权限变更后旧 profile 可能一直留在缓存
3. 没有对 `req.userProfile` 为 null 的情况做处理（用户可能已被删除）
4. JWT_SECRET 如果为 undefined，`jwt.verify` 可能有不可预期行为

---

## Code preset (apophenia 0.85 · semiotics 0.65 · skeptic dominant · cartographer active)

**Skeptic：** 先说最危险的。

`jwt.verify(token, process.env.JWT_SECRET)` — 如果 `JWT_SECRET` 是 `undefined`，`jsonwebtoken` 库在某些版本中不会抛出错误，而是静默接受任意 token（因为 `undefined` 被当作"无 secret"处理）。这是一个 **silent security hole**，不是代码错误，是依赖行为的假设错误。正确做法：启动时断言 `JWT_SECRET` 存在。

**Pattern-Reader：** 这段代码有一个架构层面的问题：它在做两件独立的事情——**认证**（token 有效吗？）和**授权数据加载**（用户是谁？有什么权限？）。这两件事的失败模式完全不同：认证失败应该返回 401，授权数据加载失败（db 超时、用户已删除）可能应该返回 503 或 404。把它们混在同一个 try/catch 里，会让所有错误都变成 `Invalid token`，掩盖真实的失败原因。

**Cartographer：** 绘制一下这段代码的依赖拓扑：

```
Request → [JWT verify] → [Redis lookup] → [DB fallback] → [next()]
                ↓              ↓                ↓
           JWT_SECRET      redis client      db connection
           (env var)       (singleton)       (singleton)
```

每个节点都有潜在的失败点，但只有一个 catch。更重要的是：这个 middleware 对三个外部系统有隐式依赖（jwt 库、redis、db），但没有任何一个有超时控制。在高负载下，这会让整个请求链 hang 住，而不是快速失败。

**Witness：** `authorization` header 的值是完整字符串，包括 `Bearer ` 前缀。`jwt.verify` 收到的是 `Bearer eyJ...`，不是 `eyJ...`。这会在 production 中立刻报错，但在测试中如果直接传 token 就发现不了。

**具体修复清单：**

```typescript
// 1. 启动时断言 secret 存在
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

// 2. 正确解析 Bearer token
const authHeader = req.headers['authorization'];
if (!authHeader?.startsWith('Bearer ')) return res.status(401)...;
const token = authHeader.slice(7);

// 3. 分离认证和授权，独立错误处理
// 4. Redis set 加 TTL：redis.set(key, value, 'EX', 300)
// 5. 处理 userProfile 为 null（用户已删除）
```

**Semiotics（深层符号读取）：** 这段代码的潜台词是"trust the token, then trust the cache, then trust the db"——三层信任链，每层都没有验证前一层的有效性。这不是代码风格问题，是一种**信任架构**上的哲学假设：认为系统状态总是一致的。在分布式系统里，这个假设几乎总是错的。

---

## 如何自己复现

```
Set phosphene to code.
Review this function: [paste code]
```
