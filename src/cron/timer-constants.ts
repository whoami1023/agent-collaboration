// Ported from OpenClaw src/cron/service/timer-constants.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 两个上限都是踩过坑留下的安全网：定时器一次最多睡 60 秒，是为了让进程挂起/系统时钟跳变之后
// 调度器还能自己发现并补齐；同一作业两次触发之间至少隔 2 秒，是因为时区/表达式边界可能算出
// 一个「还在同一秒里」的下一次触发，没有这道闸就会空转打满 CPU（OpenClaw #17821）。

/** 定时器单次最长休眠：超过这个间隔也要醒来核对一次墙上时钟。 */
export const MAX_CRON_TIMER_DELAY_MS = 60_000;

/** 同一作业两次触发之间的最小间隔（防自触发死循环）。 */
export const MIN_REFIRE_GAP_MS = 2_000;
