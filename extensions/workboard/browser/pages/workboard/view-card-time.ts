import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";

const subscribers = new Map<() => void, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (!subscribers.size || document.visibilityState === "hidden") {
    return;
  }
  const now = Date.now();
  let delay = 60_000;
  for (const timestamp of subscribers.values()) {
    delay = Math.min(delay, 60_000 - (Math.max(0, now - timestamp) % 60_000));
  }
  timer = setTimeout(tick, delay);
}

function tick() {
  for (const update of subscribers.keys()) {
    update();
  }
  schedule();
}

function onVisibilityChange() {
  if (document.visibilityState !== "hidden") {
    tick();
  } else {
    schedule();
  }
}

/** Time since `value` in its largest whole unit, as "3h"; undefined under a minute. */
function formatElapsed(value: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - value) / 60_000);
  const unit = minutes >= 1440 ? 1440 : minutes >= 60 ? 60 : 1;
  return formatDurationCompact(Math.floor(minutes / unit) * unit * 60_000);
}

function formatCardTime(value: number, now: number) {
  const time = formatElapsed(value, now);
  return time ? t("workboard.cardUpdatedAgo", { time }) : t("workboard.cardUpdatedNow");
}

class RelativeTimeDirective extends AsyncDirective {
  private timestamp = 0;
  private readonly updateTime = () => this.setValue(this.formatTime(this.timestamp, Date.now()));

  protected formatTime(timestamp: number, now: number) {
    return formatCardTime(timestamp, now);
  }

  render(timestamp: number, now: number) {
    this.timestamp = timestamp;
    if (this.isConnected) {
      this.subscribe();
    }
    return this.formatTime(timestamp, now);
  }

  protected override disconnected() {
    subscribers.delete(this.updateTime);
    if (!subscribers.size) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    schedule();
  }

  protected override reconnected() {
    this.updateTime();
    this.subscribe();
  }

  private subscribe() {
    if (!subscribers.size) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    // Cards and automation headings share one clock; only their text parts update.
    subscribers.set(this.updateTime, this.timestamp);
    schedule();
  }
}

class AutomationNextRunTimeDirective extends RelativeTimeDirective {
  protected override formatTime(timestamp: number, now: number) {
    const remaining = timestamp - now;
    if (remaining <= 0) {
      return t("workboard.automationNextRunDue");
    }
    const unit = remaining >= 86_400_000 ? "day" : remaining >= 3_600_000 ? "hour" : "minute";
    const unitMs = unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : 60_000;
    return t("workboard.automationNextRun", {
      time: new Intl.RelativeTimeFormat(workboardLocale(), { numeric: "always" }).format(
        Math.ceil(remaining / unitMs),
        unit,
      ),
    });
  }
}

class StageAgeDirective extends RelativeTimeDirective {
  protected override formatTime(timestamp: number, now: number) {
    return formatElapsed(timestamp, now) ?? t("workboard.cardUpdatedNow");
  }
}

class ListedTimeDirective extends RelativeTimeDirective {
  protected override formatTime(timestamp: number, now: number) {
    const time = formatElapsed(timestamp, now);
    return time ? t("workboard.screensListedAgo", { time }) : t("workboard.screensListedNow");
  }
}

export const cardRelativeTime = directive(RelativeTimeDirective);
export const listedTime = directive(ListedTimeDirective);
export const stageAge = directive(StageAgeDirective);
export const automationNextRunTime = directive(AutomationNextRunTimeDirective);
