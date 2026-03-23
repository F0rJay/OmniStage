"use client";

import Link from "next/link";
import { type CSSProperties, FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  characterCardJsonToForm,
  EMPTY_TAVERN_CHARACTER_CARD_FORM,
  formToCharacterCardJson,
  type TavernCharacterCardForm,
} from "@/lib/tavern-character-form";

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  marginBottom: "0.75rem",
};

function CardFields({
  card,
  onChange,
}: {
  card: TavernCharacterCardForm;
  onChange: (next: TavernCharacterCardForm) => void;
}) {
  const row = (
    label: string,
    key: keyof TavernCharacterCardForm,
    multiline = true,
    rows = 4
  ) => (
    <div style={fieldStyle}>
      <label htmlFor={`cc-${String(key)}`}>{label}</label>
      {multiline ? (
        <textarea
          id={`cc-${String(key)}`}
          className="input"
          rows={rows}
          value={card[key]}
          onChange={(e) => onChange({ ...card, [key]: e.target.value })}
        />
      ) : (
        <input
          id={`cc-${String(key)}`}
          className="input"
          type="text"
          value={card[key]}
          onChange={(e) => onChange({ ...card, [key]: e.target.value })}
        />
      )}
    </div>
  );

  return (
    <>
      {row("角色描述（description）", "description", true, 3)}
      {row("个性（personality）", "personality", true, 4)}
      {row("场景（scenario）", "scenario", true, 4)}
      {row("第一条消息（first_mes）", "first_mes", true, 3)}
      {row("示例消息（mes_example）", "mes_example", true, 5)}
      {row("外貌（appearance）", "appearance", true, 3)}
      {row("背景故事（backstory）", "backstory", true, 5)}
      {row("关系（relationships）", "relationships", true, 3)}
      {row("说话方式（speech_patterns）", "speech_patterns", true, 3)}
      {row("历史后指令（post_history_instructions）", "post_history_instructions", true, 3)}
      {row("创建者注释（creator_notes）", "creator_notes", true, 2)}
      {row("替代问候（每行一条，alternate_greetings）", "alternateGreetingsLines", true, 3)}
    </>
  );
}

export default function CharacterEditorForm(props: {
  mode: "create" | "edit";
  characterId?: string;
  initialName?: string;
  initialTags?: string;
  initialCardJson?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(props.initialName ?? "");
  const [tags, setTags] = useState(props.initialTags ?? "");
  const [card, setCard] = useState<TavernCharacterCardForm>(() =>
    props.initialCardJson
      ? characterCardJsonToForm(props.initialCardJson)
      : { ...EMPTY_TAVERN_CHARACTER_CARD_FORM }
  );
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setStatus("请填写角色名称。");
      return;
    }
    const characterCardJson = formToCharacterCardJson(card);
    setStatus("保存中…");
    if (props.mode === "create") {
      const res = await fetch("/api/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, tags, characterCardJson }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus(j.error ?? "创建失败");
        return;
      }
      const data = (await res.json()) as { character?: { id: string } };
      setStatus("已创建");
      if (data.character?.id) {
        router.push(`/tavern/characters/${data.character.id}`);
        router.refresh();
      } else {
        router.push("/tavern/characters");
      }
      return;
    }
    if (!props.characterId) {
      setStatus("缺少角色 ID。");
      return;
    }
    const res = await fetch(`/api/characters/${props.characterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: n, tags, characterCardJson }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus(j.error ?? "保存失败");
      return;
    }
    setStatus("已保存");
    router.refresh();
  }

  async function onDelete() {
    if (props.mode !== "edit" || !props.characterId) return;
    if (!window.confirm("确定删除该角色？使用此角色的会话将自动解绑。")) return;
    setDeleting(true);
    setStatus("删除中…");
    const res = await fetch(`/api/characters/${props.characterId}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus(j.error ?? "删除失败");
      return;
    }
    router.push("/tavern/characters");
    router.refresh();
  }

  return (
    <form className="panel" onSubmit={onSubmit} style={{ marginTop: "1rem" }}>
      <p className="muted" style={{ marginTop: 0 }}>
        字段对齐{" "}
        <a
          href="https://sillytavern.wiki/usage/characters/"
          target="_blank"
          rel="noreferrer"
        >
          SillyTavern「角色」
        </a>
        ；不含头像与多模态。数据存入角色卡 JSON，并可在会话中绑定为 AI 扮演身份。
      </p>
      <div style={fieldStyle}>
        <label htmlFor="char-name">名称 *</label>
        <input
          id="char-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
        />
      </div>
      <div style={fieldStyle}>
        <label htmlFor="char-tags">标签（逗号分隔，可选）</label>
        <input
          id="char-tags"
          className="input"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          maxLength={500}
          placeholder="例如：奇幻, NPC, 店主"
        />
      </div>
      <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>角色卡内容</h3>
      <CardFields card={card} onChange={setCard} />
      <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <button className="button primary" type="submit">
          {props.mode === "create" ? "创建角色" : "保存修改"}
        </button>
        <Link className="button" href="/tavern/characters">
          返回列表
        </Link>
        {props.mode === "edit" ? (
          <button
            type="button"
            className="button"
            disabled={deleting}
            onClick={() => void onDelete()}
            style={{ borderColor: "var(--danger, #c44)" }}
          >
            删除角色
          </button>
        ) : null}
      </div>
      {status ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          {status}
        </p>
      ) : null}
    </form>
  );
}
