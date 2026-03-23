# 世界书本体 & 人物书（Lorebook）规范

> **目标**：WorldForge / 导入管线不仅产出「骨架式」`entities` / `relations` / `lore_entries`，还要产出 **SillyTavern 风格可运营的世界书条目层**——用于**触发注入**、**排序**与**创作边界**，与人物卡绑定的 **人物书** 同理。  
> 参考玩家社区常见能力：[SillyTavern 世界书入门与配置思路](https://www.rainlain.com/index.php/2024/11/19/2645/)（条目、位置、顺序、触发等概念对齐）。

---

## 1. 与现有 Canonical 的关系

| 层级 | 作用 | Canonical 字段 |
|------|------|----------------|
| **骨架** | 图查询、版本 diff、DRE 实体锚点 | `entities`, `relations`, `rules`, `timeline`, `lore_entries`（粗粒度） |
| **世界书本体** | 面向 LLM 的**条目化**注入：国家/文化/组织/历史等 | **`world_book`**（可选） |
| **人物书** | 绑定角色，扩写关系/私设/场景认知，减 OOC | **`character_books`**（可选，数组） |

`lore_entries` 可保留为**摘要或索引**；**长文扩写、触发策略**放在 `world_book.entries` / `character_books[].entries`。

---

## 2. `world_book`（世界书）

```json
{
  "kind": "world",
  "name": "艾雅法拉世界书",
  "entries": [
    {
      "id": "mobile_cities",
      "title": "移动城邦",
      "memo": "世界观核心设定",
      "content": "……长文……",
      "keys": ["移动城邦", "城邦", "迁徙"],
      "strategy": "keyword",
      "position": "before_character",
      "depth": null,
      "order": 100,
      "trigger_probability_percent": 100,
      "enabled": true
    }
  ]
}
```

### 2.1 条目字段（`entries[]`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string? | 稳定 slug，便于 diff / 锁定 |
| `title` | string? | 标题（可与 `memo` 二选一展示） |
| `memo` | string? | 短备忘，UI 列表用 |
| `content` | string | **注入正文**（可与 `body` 二选一，服务端归一） |
| `body` | string? | 同 `content` |
| `keys` | string[]? | **触发关键词**（用户消息/上下文扫描） |
| `strategy` | string? | `constant`：始终候选；`keyword`：有关键词命中才候选；可扩展 `regex` |
| `position` | string? | `before_character` / `after_character` / `deep` / `author_note`（与 ST「位置」概念对齐，酒馆注入时映射到 system 片段顺序） |
| `depth` | number \| null? | 对话深度（第几条消息后生效）；`null` 表示不限制 |
| `order` | number? | 同位多条的排序，**越大越后**或按产品约定统一 |
| `trigger_probability_percent` | number? | 0–100，命中后是否采样注入（100 = 必注入） |
| `enabled` | boolean? | 默认 true |

### 2.2 世界书应覆盖的内容类型（扩写指引）

- 地理与政治：国家、地区、首都、边界争端  
- 文化、宗教、语言、节日  
- 主要组织、势力、条约、禁忌  
- 历史分期、大事记（可与 `timeline` 互链：`timeline[].id` 在条目中引用）

---

## 3. `character_books`（人物书）

每项绑定**一个**可扮演主体（通常为 1 人；卡面设计为「多人组合」时，仍在同一本中写清各自分工与称呼）。  
**与 SillyTavern 对齐**：除 Lorebook 式 **`entries`** 外，每项**必须**包含 **`character_card`**——相当于可导入/可在「角色管理」中展示的**完整角色卡内容**（与酒馆「角色描述、性格、场景、开场白、示例消息」同一语义）。

### 3.0 `character_card`（SillyTavern 语义完整角色卡）

放在 `character_books[]` 的**同一对象**内，与 `bound_entity_*` 并列。字段名尽量兼容 **SillyTavern 角色卡 JSON（V2 常见导出）** 习惯，便于日后做导出适配；未列字段可省略。

| 字段 | 类型 | 说明（与酒馆对应关系） |
|------|------|------------------------|
| `name` | string? | 显示名；可与 `bound_entity_name` 一致 |
| `description` | string | **角色描述**：快速了解该角色与卡面主旨（对应 ST 主描述区） |
| `personality` | string | **性格**：个性、情绪习惯、价值取向 |
| `scenario` | string | **场景**：默认处境、与玩家相遇语境、当前任务/环境 |
| `first_mes` | string | **开场白**：首条消息（同 ST `first_mes`） |
| `mes_example` | string | **示例对话**：`<START>` 分隔的多轮示例（同 ST） |
| `creator_notes` | string? | 作者备注（可选） |
| `post_history_instructions` | string? | 对话后置/风格指令（可选，对应 ST 同类字段） |
| `alternate_greetings` | string[]? | 备选开场白（可选） |
| `tags` | string[]? | 标签（可选） |
| `appearance` | string? | **外貌与着装**（CanonWeave 显式字段；导出 ST 时可并入 `description`） |
| `backstory` | string? | **经历与背景**（CanonWeave 显式字段） |
| `relationships` | string? | **人际关系**摘要（可与 `relations` 互链，避免与世界书全局事实冲突） |
| `speech_patterns` | string? | **口癖、称呼习惯、对事物的态度**（说话层面） |

**多人一卡**：在 `description` 与 `scenario` 中写明「组合」结构（例如双人共用开场、或分角色标注说话人）；`first_mes` / `mes_example` 应体现互动方式。

示例（节选）：

```json
{
  "character_books": [
    {
      "kind": "character",
      "name": "艾雅法拉 · 人物书",
      "bound_entity_id": "eyjafjalla",
      "bound_entity_name": "艾雅法拉",
      "character_card": {
        "name": "艾雅法拉",
        "description": "……角色描述（让读者一眼懂这张卡）……",
        "personality": "……",
        "scenario": "……",
        "appearance": "……",
        "backstory": "……",
        "relationships": "……",
        "speech_patterns": "……",
        "first_mes": "*她抬起头，轻声问好。*\n「博士，您好。」",
        "mes_example": "<START>\n{{user}}: …\n{{char}}: …",
        "post_history_instructions": "保持听障设定下的说话节奏；避免突然改变核心性格。",
        "alternate_greetings": ["……"],
        "tags": ["Arknights", "罗德岛"]
      },
      "entries": [
        {
          "id": "eyja_swimsuit",
          "title": "泳装设定",
          "content": "……",
          "keys": ["泳装", "海边"],
          "strategy": "keyword",
          "position": "before_character",
          "order": 100,
          "trigger_probability_percent": 100,
          "enabled": true
        }
      ]
    }
  ]
}
```

### 3.1 人物书条目侧重（`entries`，Lorebook 触发层）

- 人际关系、秘密、口癖、恐惧与动机  
- 与 TA 强相关的地名、组织、专有名词（避免整本世界书噪音）  
- **减少超游**：可设 `position: author_note` 类仅后台约束（若产品支持分层注入）

---

## 4. 运行时注入（CanonWeave 酒馆）

**当前**：`formatWorldContextForPrompt` 主要注入整段 `canonical_json`。  
**目标演进**（实现可分步）：

1. 从 `world_book.entries` 与当前用户句做 **keyword / 正则** 命中，按 `order` + `position` 拼块。  
2. 会话若绑定 **角色**，合并对应 `character_books[].entries`。  
3. `constant` 策略条目每轮进入候选池（受总 token 预算截断）。  

与 **Mem0 / 分层记忆** 的关系：Lorebook 偏 **静态设定**；Mem0 偏 **回合沉淀**。冲突时仍以 **世界书 + locks** 为准。

---

## 5. WorldForge 产出要求（子系统）

扩写节点除输出原 Canonical 七段外，**应尽力输出**：

- `world_book`：至少 8～20 条高质量 `entries`，覆盖地理/政治/文化/组织/历史。  
- `character_books`：对 `entities` 中 `kind` 为角色/重要 NPC 的实体，**每人一本**；**每本必须含填好的 `character_card`（完整酒馆式角色卡）**，并另附 **3～8 条** `entries` 作为触发向 Lore 补充。  

若 token 不足：可压缩 `entries` 条数，但**不应**掏空 `character_card` 的核心字段（至少 `description`、`personality`、`scenario`、`first_mes` 要有实质内容）；人物书可只覆盖主角与 2～3 名关键 NPC。

### 5.1 与 WorldForge LangGraph 的衔接（WF-2 / WF-3）

编排见 **`docs/world-forge.md`**，实现 **`world-forge-langgraph-unified.ts`**：

| 阶段 | 与 Lorebook 的关系 |
|------|-------------------|
| **解析员** | 摘要与缺口为下游提供素材；提示中可建议联网检索（若宿主提供 MCP）。 |
| **架构师（并行）** | 偏 **世界范围**叙事与势力/历史骨架，为 `world_book.entries` 提供正文与关键词线索。 |
| **机制设计师（并行）** | 规则、代价与边界，宜落入 `rules` 与/或 `world_book` 中「机制类」条目。 |
| **人物卡设计师（并行）** | 专供 **`character_books`**：每人输出 **完整 `character_card`（ST 语义）** + 人物书 `entries` 草案 + `keys`；关系、动机、禁忌、易 OOC 点。 |
| **合成节点** | `generateCanonicalDraftWithModel`：将三轨 Markdown 合并为 **单一 Canonical JSON**，须含（尽力）`world_book` / `character_books`。 |
| **审查员** | **`WF_REVIEWER_SYSTEM`**：**并列**审查 `world_book` 条目质量与 `character_books` 绑定/一致性，不得只审其一。 |

---

## 6. 校验

`parseAndValidateCanonicalWorld`：**可选**字段；若出现则：

- `world_book` 须为对象；`entries` 若存在须为数组。  
- `character_books` 须为数组；每项须为对象，`entries` 若存在须为数组。  

详见 `apps/web/src/lib/canonical-world.ts`。

---

## 7. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-03-22 | 初版：世界书/人物书本体 schema、与 WorldForge / 酒馆注入对齐说明。 |
| 2026-03-22 | 补充 §5.1：与 WF-2/WF-3 三轨并行 + 合成 + 审查员双轨同审的衔接说明。 |
| 2026-03-22 | §3：`character_books[]` 每项增加 **`character_card`**，对齐 SillyTavern 角色卡完整语义（描述/性格/场景/开场/示例对话等）。 |
