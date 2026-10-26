#!/usr/bin/env python3
"""clone_speak.py — F5-TTS-MLX 克隆朗读的合成桥（v2：批量 + euler 加速）。

tts.mjs 的 clone 引擎调用本脚本：给定参考音频（音色）与句子列表，
合成 24kHz wav。v2 相对 v1 的三个加速点：

1. 模型只加载一次（v1 每句一个进程、每次 from_pretrained）
2. 采样方法 euler（v1 默认 rk4：每步 4 次网络评估，8 步=32 次；euler 8 步=8 次）
3. 中文时长估计改为按字数启发式（v1 复用包内估计，其比值基准对
   「参考音频长、参考台词也长」的音色会高估，白算很多帧）

用法：
  批量（推荐，tts.mjs 走这条）：
    python3 clone_speak.py --batch <plan.json> --out-dir <目录>
    plan.json = {"ref": "...", "ref_text": "...",
                 "segments": [{"text": "...", "speed": 1.0}, ...]}
    stdout 最后一行输出 JSON：{"files": ["...", ...]}（按 segments 顺序）
    stderr 输出进度：合成中 i/N…

  单句（兼容旧用法）：
    python3 clone_speak.py --ref <ref_24k.wav> --ref-text "<台词>" \
        --text "<一句话>" --out <out.wav> [--speed 1.0]

注意：参考音频必须是 24kHz 单声道 wav（tts.mjs 会先用 afconvert 转好）。
"""
import argparse
import json
import math
import sys

# mlx 0.32 起 random.normal 不收 tuple，只收 list；f5-tts-mlx 0.x 老代码用 tuple。
# 在 import 之前包一层包装，免得改 site-packages（pip 升级后补丁也会丢）。
import mlx.core as _mx
_orig_normal = _mx.random.normal


def _normal_compat(*args, **kwargs):
    if args and isinstance(args[0], tuple):
        args = (list(args[0]),) + args[1:]
    return _orig_normal(*args, **kwargs)


_mx.random.normal = _normal_compat

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

from f5_tts_mlx.cfm import F5TTS  # noqa: E402
from f5_tts_mlx.utils import convert_char_to_pinyin  # noqa: E402

SAMPLE_RATE = 24_000
HOP_LENGTH = 256
FRAMES_PER_SEC = SAMPLE_RATE / HOP_LENGTH
TARGET_RMS = 0.1
# 中文自然语速约 4~5 字/秒；留一点余量防尾字被吞
CHARS_PER_SEC = 4.3
ZH_PAUSE_PUNC = "。，、；：？！…—"

_pinyin_cache: dict[str, list] = {}


def pinyin(text: str) -> list:
    if text not in _pinyin_cache:
        _pinyin_cache[text] = convert_char_to_pinyin([text])
    return _pinyin_cache[text]


def load_ref(path: str):
    audio, sr = sf.read(path)
    if sr != SAMPLE_RATE:
        raise ValueError(f"参考音频必须是 {SAMPLE_RATE}Hz，实际 {sr}Hz")
    audio = np.asarray(audio, dtype=np.float32)
    rms = float(_mx.sqrt(_mx.mean(_mx.square(_mx.array(audio)))))
    if rms < TARGET_RMS:
        audio = audio * (TARGET_RMS / rms)
    return audio


def estimate_frames(ref_frames: int, gen_text: str, speed: float) -> int:
    """生成总帧数 = 参考帧数 + 按字数估的新增时长。"""
    units = len(gen_text.strip()) + 2 * sum(1 for c in gen_text if c in ZH_PAUSE_PUNC)
    speech_sec = units / (CHARS_PER_SEC * max(speed, 0.25))
    return ref_frames + int(math.ceil(speech_sec * FRAMES_PER_SEC))


class Synth:
    # steps=8：euler 4 步会出噪音（CFM 轨迹积分步数太少直接崩），8 步是质量/速度的甜点
    def __init__(self, model_name: str = "lucasnewman/f5-tts-mlx",
                 steps: int = 8, method: str = "euler"):
        self.model = F5TTS.from_pretrained(model_name)
        self.steps = steps
        self.method = method

    def sentence(self, ref, ref_text: str, text: str, speed: float):
        ref_frames = ref.shape[0] // HOP_LENGTH
        duration = estimate_frames(ref_frames, text, speed)
        tokens = pinyin(ref_text + " " + text)
        wave, _ = self.model.sample(
            _mx.expand_dims(_mx.array(ref), axis=0),
            text=tokens,
            duration=duration,
            steps=self.steps,
            method=self.method,
            speed=speed,
        )
        wave = wave[ref.shape[0]:]
        _mx.eval(wave)
        return np.array(wave, dtype=np.float32)


def run_batch(plan: dict, out_dir: str) -> list:
    ref = load_ref(plan["ref"])
    ref_text = plan["ref_text"].strip()
    segments = plan["segments"]
    synth = Synth()
    files = []
    for i, seg in enumerate(segments):
        text = seg["text"].strip()
        if not text:
            files.append("")
            continue
        speed = float(seg.get("speed", 1.0) or 1.0)
        print(f"合成中 {i + 1}/{len(segments)}…", file=sys.stderr, flush=True)
        wave = synth.sentence(ref, ref_text, text, speed)
        path = f"{out_dir}/seg_{i:03d}.wav"
        sf.write(path, wave, SAMPLE_RATE)
        files.append(path)
    return files


def run_single(args) -> int:
    ref = load_ref(args.ref)
    ref_text = args.ref_text.strip()
    synth = Synth(steps=args.steps, method=args.method)
    wave = synth.sentence(ref, ref_text, args.text, args.speed)
    sf.write(args.out, wave, SAMPLE_RATE)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', help='批量计划 JSON 文件路径')
    parser.add_argument('--out-dir', help='批量模式输出目录')
    parser.add_argument('--ref', help='参考音频（24kHz wav）')
    parser.add_argument('--ref-text', help='参考音频的台词原文')
    parser.add_argument('--text', help='要合成的话')
    parser.add_argument('--out', help='输出 wav 路径')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--method', default='euler', choices=['euler', 'midpoint', 'rk4'])
    args = parser.parse_args()

    if args.batch:
        if not args.out_dir:
            print('--batch 需要 --out-dir', file=sys.stderr)
            return 1
        with open(args.batch, encoding='utf-8') as f:
            plan = json.load(f)
        files = run_batch(plan, args.out_dir)
        print(json.dumps({"files": files}, ensure_ascii=False))
        return 0

    if not (args.ref and args.ref_text and args.text and args.out):
        print('单句模式需要 --ref --ref-text --text --out', file=sys.stderr)
        return 1
    if not args.text.strip():
        print('empty text', file=sys.stderr)
        return 1
    return run_single(args)


if __name__ == "__main__":
    sys.exit(main())
