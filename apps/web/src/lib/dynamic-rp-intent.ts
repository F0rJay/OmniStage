import "server-only";

export type DynamicRpIntentKind = "dialogue" | "action";

export type DynamicRpIntent = {
  kind: DynamicRpIntentKind;
  /** 便于调试与事件回放 */
  reason: string;
};

/**
 * DRE-0：轻量规则路由。默认对话，避免误判闲聊为战斗。
 * 后续可换小模型分类（DRE-1）且保留本函数为 fast-path。
 */
export function classifyDynamicRpIntent(text: string): DynamicRpIntent {
  const t = text.trim();
  if (t.length < 2) {
    return { kind: "dialogue", reason: "过短" };
  }

  const actionPatterns: RegExp[] = [
    /我要(偷袭|袭击|攻击|打|杀|跑|逃|离开|冲出去|冲进去|拔剑|拔刀|拔枪|躲|闪|格挡|爬|跳|踢|踹|推|拉|砸|撬|搜|翻找|念咒|施法|治疗|捆|绑|锁门|破门|潜行|瞄准|射击|投掷)/,
    /(偷袭|袭击|攻击|开打|拔剑|拔刀|拔枪|潜行|躲藏|闪避|格挡|瞄准|射击|投掷|翻越|捆绑|锁门|破门|冲上去|扑向)/,
    /^我(先|立刻|马上)?(动手|出手|开打|跑|逃|冲|躲|闪)/,
    /^(对|朝|向).+(动手|打|开枪|挥|刺|砍)/,
  ];

  for (let i = 0; i < actionPatterns.length; i++) {
    if (actionPatterns[i].test(t)) {
      return { kind: "action", reason: `keyword#${i + 1}` };
    }
  }

  if (/^(谁|什么|怎么|为什么|哪|几|是否|能不能|可以吗)/.test(t)) {
    return { kind: "dialogue", reason: "疑问式" };
  }
  if (/[？?！!…]$/.test(t) && t.length < 48) {
    return { kind: "dialogue", reason: "短句标点" };
  }

  return { kind: "dialogue", reason: "default_dialogue" };
}
