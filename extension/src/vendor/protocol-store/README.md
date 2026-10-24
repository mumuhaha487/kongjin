# 商店版 2.0.1 协议基线

从 shared/protocol/src 只读复制既有 types、crypto、pow、pow.worker、sync；sync.ts 的 SHA-256 为 d44706af089c5a527c46d596c0bb1a0013ef455f31d073b4beb77032d94462e7。
本目录只供 KJ_STORE 生产构建使用，保留审核中的 2.0.1 协议行为，避免新共享库的接力通道进入商店包。
index.ts 只导出原有四个模块。供应代码不纳入项目自身风格 lint；编译、既有测试、构建自检照常执行。

## 商店版 2.0.3 配对关闭竞态补丁

按 PM 授权，从 v2.2.2 的 sync.ts（SHA-256：a4b838a3962ca9f88fbcb962d6540c5066004806fb1eb4f14b40b9bab4777eb7）仅移植 invite()、join() 内的握手关闭竞态处理，以及专供 welcome 后首次组连接等待的 connectAfterWelcome()。其余方法、导出和协议消息保持冻结基线，不引入日志、状态槽、blob 或接力代码。

配对传输的 close/error 排在已收到消息的处理链之后；邀请方已发送 welcome 后继续完成持久化、成员广播和快照提交。加入方完成 welcome 解密/校验、凭证持久化以及首次组 WebSocket open 后才成功，首次连接超时30秒或真实错误仍失败。后续快照拉取沿用组连接原有流程。

移植范围校验：extension/tests/store-203-port-scope.json；确定性回归：extension/tests/store-pairing-close.test.ts。本地正式商店ZIP加载与B输入配对码的实测：extension/scripts/store-203-integration.mjs（仅本地8790）。

补丁后 sync.ts SHA-256：ed5de5e07d200d81ec802783f29c25ac00354d973e4dbd48508300eaec088aed。
