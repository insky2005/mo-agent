<!-- >>> mo >>> -->
## mo

本仓库用 mo 管理任务。要把讨论落地时：

1. 补清交付物、验收标准、边界，再 `mo task create --json`；
2. 把卡摘要给用户，**停下等批准**（`mo task confirm <taskId>` 只发起请求，批准由人做）；
3. 批准后 `mo task dispatch <taskId> --json`，只按 `mo task status` / `mo ledger query` 汇报；
4. 执行者没写回执（`missing_receipt`）一律视为未完成。
<!-- <<< mo <<< -->
