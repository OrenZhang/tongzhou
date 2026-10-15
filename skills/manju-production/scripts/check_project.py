#!/usr/bin/env python3
"""只读移植/单集结构检查；不代替内容、画面及用户审核。"""
import argparse
import json
from pathlib import Path
import re
import math
import sys
from pathlib import PureWindowsPath


ROOT = Path.cwd().resolve()
ASSET = re.compile(r"@([\w\u4e00-\u9fff（）()·-]+)")
SHOT = re.compile(r"EP\d{2,}_S\d{3}[A-Z]?")
BLOCK = re.compile(r"^## (EP\d{2,}_B\d{3})[^\n]*\n(.*?)(?=^## EP\d{2,}_B|\Z)", re.M | re.S)


class Check:
    def __init__(self, stage="delivery", max_block_seconds=15):
        self.errors = []
        self.stage = stage
        self.max_block_seconds = max_block_seconds
        self.statistics = {}

    def require(self, condition, message):
        if not condition:
            self.errors.append(message)

    def file(self, path):
        try:
            path.resolve().relative_to(ROOT)
        except ValueError:
            self.require(False, f"文件引用越出项目根目录：{path}")
            return ""
        label = path.relative_to(ROOT)
        self.require(path.is_file(), f"缺少文件：{label}")
        if not path.is_file():
            return ""
        with path.open("rb") as stream:
            header = stream.read(64)
        self.require(bool(header), f"文件为空：{label}")
        self.require(not header.startswith(b"version https://git-lfs.github.com/spec/v1"),
                     f"尚未下载 LFS 文件：{label}")
        if path.suffix.lower() == ".png":
            self.require(len(header) >= 24 and header.startswith(b"\x89PNG\r\n\x1a\n") and
                         header[12:16] == b"IHDR" and int.from_bytes(header[16:20], "big") > 0 and
                         int.from_bytes(header[20:24], "big") > 0, f"不是有效的 PNG 图像头：{label}")
        if path.suffix.lower() in {".md", ".txt", ".json"}:
            text = path.read_text(encoding="utf-8")
            self.require(bool(text.strip()), f"文件内容为空：{label}")
            return text
        return ""

    def project(self):
        series_root = ROOT / "连载"
        series = [p for p in series_root.iterdir() if p.is_dir()] if series_root.is_dir() else []
        self.require(bool(series), "未找到连载制作档案；本检查不把空项目判为完成")
        for item in series:
            self.file(item / "README.md")

        def inspect(value, record):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"dest", "refs"}:
                        for reference in item if isinstance(item, list) else [item]:
                            if not isinstance(reference, str) or not reference.strip() or "\0" in reference:
                                self.require(False, f"文件引用不是非空路径：{record} 的 {key}")
                                continue
                            if Path(reference).is_absolute() or PureWindowsPath(reference).drive:
                                self.require(False, f"机器绝对路径：{record} 的 {key}")
                                continue
                            self.file(ROOT / reference.replace("\\", "/"))
                    elif isinstance(item, (dict, list)):
                        inspect(item, record)
            elif isinstance(value, list):
                for item in value:
                    inspect(item, record)
        if series_root.is_dir():
            for record in series_root.rglob("*.json"):
                try:
                    inspect(json.loads(self.file(record)), record.relative_to(ROOT))
                except (OSError, ValueError, TypeError) as error:
                    self.require(False, f"生成记录格式错误：{record.relative_to(ROOT)}：{error}")
        self.statistics["series"] = len(series)

    def episode(self, episode):
        if not episode.is_relative_to(ROOT) or episode.parent.name != "改编":
            raise ValueError("单集目录须位于项目内的 <作品>/改编/第XX集")
        series = episode.parent.parent
        number = re.fullmatch(r"第(\d{2,})集", episode.name)
        if not number:
            raise ValueError("--episode 应指向 连载/<作品>/改编/第XX集")
        ep = "EP" + number.group(1)
        package = series / "制作" / episode.name / "视频输入" / f"{ep}_整集输入"
        self.file(episode / "剧本.md")
        if self.stage == "script":
            self.statistics = {"episodes": 1}
            return
        board = self.file(episode / "分镜脚本.md")
        prompt = self.file(episode / "生成提示词.md")
        self.file(series / "资产" / episode.name / "资产清单.md")
        if self.stage == "delivery":
            self.file(package / "素材清单.md")
            copies = [p for p in (package / "整集提示词.md", package / "生成提示词.md") if p.is_file()]
            self.require(len(copies) == 1, "输入包应有一份整集提示词.md或生成提示词.md")
            if len(copies) == 1:
                def normalized(value):
                    return "\n".join(re.sub(r"^## (?=EP\d+_B)", "", line).rstrip()
                                     for line in value.splitlines() if not line.startswith("```"))
                self.require(normalized(self.file(copies[0])).strip() == normalized(prompt).strip(),
                             "输入包提示词与改编当前稿不同步（忽略代码块包装及行尾空格）")
        registered = set()
        for category in ("角色", "道具", "场景"):
            for setting in (series / "资产/公共" / category).glob("*/设定.md"):
                self.file(setting)
                registered.add(setting.parent.name)
        names = set(ASSET.findall(board + "\n" + prompt))
        for name in sorted(names):
            self.require(name in registered, f"未登记的资产标识：@{name}")
            if self.stage == "delivery":
                self.file(package / "素材" / (name + ".png"))
        if self.stage == "delivery":
            for image in (package / "素材").glob("*.png"):
                self.require(image.stem in registered, f"主素材混入状态图/镜头图/未登记名：{image.name}")
                self.file(image)

        board_entries, prompt_entries = BLOCK.findall(board), BLOCK.findall(prompt)
        board_blocks, prompt_blocks = dict(board_entries), dict(prompt_entries)
        self.require(len(board_entries) == len(board_blocks), "分镜生成节编号重复")
        self.require(len(prompt_entries) == len(prompt_blocks), "提示词生成节编号重复")
        # 兼容分节总表和逐镜头表中明确的 B/S 关联。
        durations = {}
        if not board_blocks:
            for bid, duration in re.findall(r"^\|\s*(EP\d{2,}_B\d{3})\s*\|\s*(\d+(?:\.\d+)?)秒", board, re.M):
                self.require(bid not in durations, f"分节总表生成节编号重复：{bid}")
                durations[bid] = float(duration)
                suffix = bid.split("_")[1]
                rows = [line for line in board.splitlines()
                        if re.match(r"\|\s*EP\d{2,}_S\d{3}[A-Z]?\s*\|\s*" + suffix + r"\s", line)]
                board_blocks[bid] = "\n".join(rows)
        self.require(bool(board_blocks), "分镜未找到 B 级生成节")
        self.require(list(board_blocks) == list(prompt_blocks), "分镜与提示词 B 节覆盖或播放顺序不一致")
        seen = set()
        for bid, text in board_blocks.items():
            self.require(bid.startswith(ep + "_"), f"集号错误：{bid}")
            if bid not in durations:
                header = next(line for line in board.splitlines() if line.startswith("## " + bid))
                duration = re.search(r"(?:总时长\s*|[｜|]\s*)(\d+(?:\.\d+)?)秒", header)
                self.require(duration is not None, f"{bid} 缺少可读取的节时长")
                if duration:
                    durations[bid] = float(duration.group(1))
            if bid in durations:
                self.require(0 < durations[bid] <= self.max_block_seconds,
                             f"{bid} 时长须大于0且不超过{self.max_block_seconds:g}秒")
            rows = re.findall(r"^\|\s*(EP\d{2,}_S\d{3}[A-Z]?)\s*\|", text, re.M)
            self.require(bool(rows), f"{bid} 分镜表无镜头")
            for sid in rows:
                self.require(sid not in seen, f"分镜重复镜头：{sid}")
                self.require(sid.startswith(ep + "_"), f"镜头集号错误：{sid}")
                seen.add(sid)
            actual = set(SHOT.findall(prompt_blocks.get(bid, "")))
            self.require(set(rows) == actual, f"{bid} 提示词镜头覆盖不一致：分镜{sorted(rows)}，提示词{sorted(actual)}")
            prompt_text = prompt_blocks.get(bid, "")
            # 对已按新流程修订的任意集核对状态契约；不依赖集号判断采用版本。
            if (series / "制作" / episode.name / "导演场记.json").is_file():
                for field in ("【空间硬锁】", "【入口状态】", "【本节唯一主要动作】", "【出口状态】", "【禁变清单】"):
                    self.require(field in prompt_text, f"{bid} 缺少连续性字段：{field}")
                self.require("严格承接上一节结束状态" not in prompt_text,
                             f"{bid} 仍使用空泛的连续性承接语，需改为具体入口状态")
            if self.stage == "delivery":
                for side in ("首帧", "尾帧"):
                    self.file(package / "镜头首帧" / f"{bid}_{side}.png")
        self.statistics = {"episodes": 1, "blocks": len(board_blocks), "shots": len(seen), "assets": len(names)}
        record = series / "制作" / episode.name / "导演场记.json"
        data = json.loads(self.file(record) or "{}")
        try:
            self.continuity(data, board, prompt_blocks, board_blocks, durations)
        except (KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            self.require(False, f"导演场记字段缺失或格式错误：{error}")

    def continuity(self, record, board, prompt_blocks, board_blocks, durations):
        """核对受控的逐镜记录与交付稿；空间合理性仍需人工审核。"""
        if not isinstance(record, dict) or not isinstance(record.get("shots"), list) or not record["shots"]:
            raise ValueError("shots 必须是非空数组")
        if not isinstance(record.get("device_space_limits"), dict):
            raise ValueError("device_space_limits 必须是对象")
        self.require(record["block_order"] == list(board_blocks), "导演场记与分镜播放顺序不同")
        rows = {}
        for line in board.splitlines():
            if re.match(r"^\| EP\d+_S", line):
                columns = [value.strip() for value in line.split("|")[1:-1]]
                rows[columns[0]] = columns
        self.require([shot["shot"] for shot in record["shots"]] == list(rows),
                     "导演场记与分镜逐镜播放顺序不同")
        endings = {}
        for order, shot in enumerate(record["shots"], 1):
            for key in ("shot", "block", "start", "end", "space_lock", "tool_state", "open_window", "voice_window", "close_window"):
                if not isinstance(shot[key], str) or not shot[key].strip():
                    raise ValueError(f"第{order}镜 {key} 须为非空文本")
            if not isinstance(shot["time"], list) or len(shot["time"]) != 2 or any(
                    type(t) not in (int, float) or not math.isfinite(t) for t in shot["time"]):
                raise ValueError(f"第{order}镜 time 须为两项有限秒数")
            for key in ("assets", "scenes"):
                if not isinstance(shot[key], list) or any(not isinstance(v, str) for v in shot[key]):
                    raise ValueError(f"第{order}镜 {key} 须为名称数组")
            self.require(shot["play_order"] == order, f"第{order}镜播放位错误")
            sid, bid = shot["shot"], shot["block"]
            text = prompt_blocks.get(bid, "")
            match = re.search(r"【([\d.]+)—([\d.]+)秒｜" + sid +
                              r"】\n(.*?)(?=\n【[\d.]+—[\d.]+秒｜EP|\n【本节结束状态】|\Z)", text, re.S)
            self.require(match is not None, f"{sid} 缺少逐镜可执行提示词")
            if match is None or sid not in rows:
                continue
            a, z = shot["time"]
            self.require([float(match[1]), float(match[2])] == shot["time"], f"{sid} 提示词时码不同步")
            self.require(rows[sid][1] == f"{a:g}—{z:g}秒", f"{sid} 分镜时码不同步")
            self.require(abs(a - endings.get(bid, 0)) < 0.001 and z > a, f"{sid} 节内时码有断档/重叠")
            endings[bid] = z
            assets = set(shot["assets"])
            self.require(set(ASSET.findall(rows[sid][-1])) == assets, f"{sid} 分镜入镜资产不同步")
            field = re.search(r"【资产】([^\n]*)", match[3])
            self.require(field is not None and set(ASSET.findall(field[1])) == assets,
                         f"{sid} 提示词入镜资产不同步")
            for key, value in (("空间与站位锁", shot["space_lock"] + " 起点：" + shot["start"]),
                               ("工具接触与持续状态", shot["tool_state"]), ("镜头出口", shot["end"]),
                               ("开镜余量", shot["open_window"]), ("发声时间窗", shot["voice_window"]),
                               ("收尾余量", shot["close_window"])):
                self.require("【" + key + "】" + value in match[3], f"{sid} 场记字段不同步：{key}")
            for name, allowed in record["device_space_limits"].items():
                if name in assets:
                    self.require(bool(set(shot["scenes"]) & set(allowed)), f"{sid} @{name} 绑定到错误空间")
            opening = re.match(r"([\d.]+)—([\d.]+)秒", shot["open_window"])
            closing = re.match(r"([\d.]+)—([\d.]+)秒", shot["close_window"])
            if opening and closing:
                oa, oz = map(float, opening.groups())
                ca, cz = map(float, closing.groups())
                self.require(abs(oa-a) < 0.001 and 0.199 <= oz-oa <= 0.301,
                             f"{sid} 开镜余量不符合0.2—0.3秒")
                self.require(abs(cz-z) < 0.001 and cz-ca >= 0.199, f"{sid} 收尾余量不足0.2秒")
                windows = [(float(x), float(y)) for x, y in
                           re.findall(r"([\d.]+)—([\d.]+)秒", shot["voice_window"])]
                cursor = oz
                for va, vz in windows:
                    self.require(va >= cursor-0.011 and vz <= ca+0.011 and vz >= va,
                                 f"{sid} 发声/停顿窗口重叠或挤占首尾余量")
                    cursor = vz
            else:
                self.require(False, f"{sid} 开镜/收尾时码不可读取")

        for bid, duration in durations.items():
            self.require(abs(endings.get(bid, -1) - duration) < 0.001, f"{bid} 最后镜头终点与节时长不同步")


def main():
    global ROOT
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="项目根目录；与脚本安装位置无关")
    parser.add_argument("--episode", type=Path, help="项目根相对路径，例如 连载/作品名/改编/第01集")
    parser.add_argument("--stage", choices=("script", "storyboard", "delivery"))
    parser.add_argument("--max-block-seconds", type=float, default=15, help="实际工具支持的单节秒数上限")
    parser.add_argument("--json", action="store_true", help="输出机器可读检查结果")
    args = parser.parse_args()
    if args.stage and not args.episode:
        parser.error("--stage 需要 --episode")
    if not math.isfinite(args.max_block_seconds) or args.max_block_seconds <= 0:
        parser.error("时长上限须为正数")
    ROOT = args.root.resolve()
    check = Check(args.stage or "delivery", args.max_block_seconds)
    try:
        check.require(ROOT.is_dir(), "项目根目录不存在")
        if ROOT.is_dir():
            if args.episode:
                check.episode((ROOT / args.episode).resolve())
            else:
                check.project()
    except (OSError, ValueError, TypeError) as error:
        check.require(False, f"无法完成检查：{error}")
    check.errors = list(dict.fromkeys(check.errors))
    report = {"passed": not check.errors, "stage": check.stage if args.episode else "project",
              "statistics": check.statistics, "errors": check.errors,
              "note": "仅检查所选阶段的文件结构；内容、实际媒体与采用状态仍需审核。"}
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for error in check.errors:
            print("待修正：" + error)
        print(f"结构检查：{'未通过' if check.errors else '通过'}；{len(check.errors)}项待修正。内容及画面另需审核。")
    return 1 if check.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
