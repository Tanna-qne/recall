"""把 inputs/ 里的资料做成记忆卡，写进 decks/。

GitHub Actions 每次有新资料提交时自动运行；也可以在电脑上手动运行：
    set API_BASE=https://api.openhub.pw/v1
    set API_KEY=你的 Key
    python scripts/generate.py

只用 Python 标准库。每份资料先出卡，再逐张对照资料核对一遍（有错改正，资料里没有的删掉）。
资料没改过就不会重新生成（按内容的哈希判断）。
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS = ROOT / "inputs"
DECKS = ROOT / "decks"
CHUNK = 12000  # 资料太长时按段落切块，每块最多这么多字

GEN_PROMPT = """把下面的资料做成记忆卡片。目标是有条理、方便记忆。

规则：
1. 只用资料里的内容，不编造，不补充资料以外的知识。
2. 一张卡只记一个点。正面是提问或提示，背面是简短答案，最好不超过 40 个字。
3. 按资料本身的逻辑分组，组名是这一块的主题；组内从基础到进阶排。
4. 公式一律用 LaTeX 写在 $...$ 里，比如 $E=mc^2$、$\\sin^2\\theta+\\cos^2\\theta=1$。字母、符号、单位照资料原样写。
5. 能帮记忆的，在 hint 里写一句提示：口诀、联想、或者和前一张卡的联系。没有就留空字符串。
6. 只做一问一答，不做判断题和选择题。正面要具体，看到正面就知道要答什么。
7. 资料里的重点都要有卡，但不要为凑数做没意义的卡。
8. 每张卡标出背面的"骨架"（keep）：随着复习次数增加，背面其他部分会慢慢变形、消失，骨架一直留着，帮人回想原样。骨架必须是背面里原样出现的片段：
   - 一句话或一段话：留主语、谓语动词和最关键的名词，比如"光合作用把光能转化为化学能"留 ["光合作用", "转化为", "化学能"]；
   - 公式：留结构，也就是函数名、运算符和等号，变量可以变形，比如 $\\sin(\\alpha+\\beta)=\\sin\\alpha\\cos\\beta+\\cos\\alpha\\sin\\beta$ 留 ["\\sin", "\\cos", "=", "+"]；
   - 单词：留首字母、尾字母或词根，比如 photosynthesis 留 ["photo"]。
   骨架是帮人回想的提示，不能是答案本身：要记的数值、结论、关键变量不要放进骨架，比如"sin30° = 1/2"留 ["sin30°", "="]，1/2 不留。
   骨架不要太多，一般占背面的三分之一左右；不要放单独一个数字。

只输出 JSON，不要别的文字。字符串里要用引号就用中文引号「」，不要用英文双引号：
{{"title": "这副卡的名字", "groups": [{{"name": "组名", "cards": [{{"front": "……", "back": "……", "hint": "", "keep": ["……"]}}]}}]}}

资料：
{text}"""

CHECK_PROMPT = """下面是根据资料做的记忆卡。请逐张对照资料核对：
- 背面答案是否正确、是否完全能在资料里找到依据；公式、字母、数字、单位是否和资料一致；
- 正面问得是否清楚，看到正面能不能明确知道要答什么。

每张卡给一个结论：keep（没问题）、fix（有错或不清楚，给出改正后的 front 和 back）、drop（资料里没有依据）。
拿不准的就 keep，不要把对的改错。

只输出 JSON，不要别的文字。字符串里要用引号就用中文引号「」，不要用英文双引号：
{{"verdicts": [{{"g": 组序号, "c": 卡序号, "action": "keep|fix|drop", "front": "改正后的正面（fix 时填）", "back": "改正后的背面（fix 时填）", "why": "一句话"}}]}}

卡片（组序号和卡序号都从 0 开始）：
{cards}

资料：
{text}"""


def chat(prompt: str, system: str) -> str:
    base, key = os.environ["API_BASE"].rstrip("/"), os.environ["API_KEY"]
    model = os.environ.get("MODEL") or "DeepSeek-v4-pro"
    body = {"model": model, "max_tokens": 16000, "temperature": 0.3,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode("utf-8"),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                          "User-Agent": "recall-cards/1.0"})
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            text = (data["choices"][0]["message"].get("content") or "").strip()
            if text:
                return text
            err = "空回复"
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 402, 403):
                sys.exit(f"模型服务拒绝了请求（HTTP {exc.code}）：检查 Key、余额或地址。")
            err = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError, OSError, KeyError, ValueError) as exc:
            err = type(exc).__name__
        print(f"  出错了（{err}），{15 * attempt} 秒后重试")
        time.sleep(15 * attempt)
    sys.exit("连续 3 次失败。")


def parse_json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("不是 JSON")
    return json.loads(text[start:end + 1])


def ask_json(prompt: str, system: str) -> dict:
    """模型偶尔会输出坏掉的 JSON（比如引号没转义），重问几次。"""
    for attempt in range(1, 4):
        try:
            return parse_json(chat(prompt, system))
        except ValueError as exc:  # JSONDecodeError 也是 ValueError
            print(f"  回复不是合法的 JSON（{exc}），重新生成 {attempt}/3")
    sys.exit("连续 3 次没拿到合法的 JSON。")


def chunks(text: str) -> list[str]:
    out, buf = [], ""
    for para in re.split(r"\n\s*\n", text):
        if buf and len(buf) + len(para) > CHUNK:
            out.append(buf)
            buf = ""
        buf += para + "\n\n"
    if buf.strip():
        out.append(buf)
    return out


GREEK = set("alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma "
            "tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Pi Sigma Phi Psi Omega".split())


def skeleton(keep: list, back: str) -> list:
    """骨架只留提示，不留答案：公式里只留函数名和运算符，纯数字不留。"""
    math = "".join(re.findall(r"\$[^$]+\$", back))
    out = []
    for k in keep:
        if not isinstance(k, str) or not k or k not in back:
            continue
        if k in math and not re.search(r"[一-鿿]", k):
            out += [t for t in re.findall(r"\\[A-Za-z]+|[=+\-<>]", k) if t[1:] not in GREEK]
        elif re.search(r"[A-Za-z一-鿿]", k) and len(k) < len(re.sub(r"[^\w]", "", back)) / 2:
            out.append(k)  # 占了答案一半以上的片段就是答案本身，不当骨架
    return list(dict.fromkeys(out))


def clean_card(c: dict) -> dict:
    back = str(c.get("back", ""))
    return {"front": str(c.get("front", "")), "back": back, "hint": str(c.get("hint", "")),
            "keep": skeleton(c.get("keep") or [], back)}


def make_deck(text: str) -> dict:
    title, groups = "", []
    for i, part in enumerate(chunks(text), 1):
        print(f"  出卡 {i}……")
        deck = ask_json(GEN_PROMPT.format(text=part), "你擅长把资料整理成好记的记忆卡。")
        title = title or deck.get("title", "")
        deck_groups = [g for g in deck.get("groups", []) if g.get("cards")]
        print(f"  核对 {sum(len(g['cards']) for g in deck_groups)} 张卡……")
        listed = json.dumps(deck_groups, ensure_ascii=False)
        try:
            verdicts = ask_json(CHECK_PROMPT.format(cards=listed, text=part), "你是严谨的审稿人。")["verdicts"]
        except (SystemExit, KeyError):  # 核对失败就不核对
            verdicts = []
        changed = 0
        for v in verdicts:
            try:
                card = deck_groups[int(v["g"])]["cards"][int(v["c"])]
            except (KeyError, IndexError, ValueError, TypeError):
                continue
            if v.get("action") == "drop":
                card["_drop"] = True
                changed += 1
            elif v.get("action") == "fix" and v.get("back"):
                card["front"] = v.get("front") or card["front"]
                card["back"] = v["back"]
                changed += 1
        for g in deck_groups:
            g["cards"] = [clean_card(c) for c in g["cards"] if not c.get("_drop")]
        groups += [g for g in deck_groups if g["cards"]]
        print(f"  核对改了 {changed} 张")
    return {"title": title, "groups": groups}


def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-").lower()
    return s or "deck-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]


def main() -> None:
    DECKS.mkdir(exist_ok=True)
    index_path = DECKS / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    by_id = {d["id"]: d for d in index}
    made = 0
    sources = [s for s in sorted(INPUTS.glob("*.md")) + sorted(INPUTS.glob("*.txt")) if s.name.lower() != "readme.md"]
    alive = {slug(s.stem) for s in sources}
    for deck_id in [d for d in by_id if d not in alive]:  # 资料删了，卡也删
        by_id.pop(deck_id)
        (DECKS / f"{deck_id}.json").unlink(missing_ok=True)
        print(f"删除 {deck_id}")
    for src in sources:
        raw = src.read_text(encoding="utf-8").strip()
        if not raw:
            continue
        digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
        deck_id = slug(src.stem)
        if by_id.get(deck_id, {}).get("hash") == digest:
            continue
        print(f"处理 {src.name}")
        m = re.match(r"#\s+(.+)", raw)
        deck = make_deck(raw)
        title = (m.group(1).strip() if m else "") or deck["title"] or src.stem
        count = sum(len(g["cards"]) for g in deck["groups"])
        out = {"id": deck_id, "title": title, "groups": deck["groups"]}
        (DECKS / f"{deck_id}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        by_id[deck_id] = {"id": deck_id, "title": title, "count": count, "hash": digest,
                          "updated": datetime.date.today().isoformat()}
        made += 1
        print(f"  完成：{title}，{count} 张")
    index_path.write_text(json.dumps(sorted(by_id.values(), key=lambda d: d["updated"], reverse=True),
                                     ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"这次生成了 {made} 副卡。")


if __name__ == "__main__":
    main()
