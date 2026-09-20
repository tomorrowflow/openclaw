import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { replaceGenericExternalRunFailureText } from "../agents/failover/user-copy.js";
import type { HeartbeatTerminalToolFailure } from "../auto-reply/heartbeat-reply-payload.js";
import {
  getHeartbeatToolNotificationText,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  normalizeHeartbeatReply,
  type NormalizedHeartbeatDelivery,
} from "./heartbeat-reply-normalization.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";

function normalizeHeartbeatToolNotification(
  response: HeartbeatToolResponse,
  responsePrefix: string | undefined,
): NormalizedHeartbeatDelivery {
  let finalText = getHeartbeatToolNotificationText(response);
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return {
    shouldSkip: finalText.trim().length === 0,
    text: finalText,
    hasMedia: false,
    isInternalPlaceholderOnly: false,
    ...(response.notify ? {} : { silent: true }),
  };
}

export function classifyHeartbeatAgentOutcome(params: {
  agentRun: {
    agentRunFailed: boolean;
    heartbeatToolResponse?: HeartbeatToolResponse;
    heartbeatTerminalToolFailure?: HeartbeatTerminalToolFailure;
    replyPayload?: ReplyPayload;
  };
  hasRelayableExecCompletion: boolean;
  suppressUnmarkedSourceReplies: boolean;
  responsePrefix: string | undefined;
  ackMaxChars: number;
}) {
  const { agentRunFailed, heartbeatToolResponse, heartbeatTerminalToolFailure, replyPayload } =
    params.agentRun;
  const replyMetadata = replyPayload ? getReplyPayloadMetadata(replyPayload) : undefined;
  const hasExplicitFailure = Boolean(heartbeatTerminalToolFailure || agentRunFailed);
  const shouldSuppressSourceReply =
    params.suppressUnmarkedSourceReplies &&
    !params.hasRelayableExecCompletion &&
    replyPayload &&
    replyPayload.isError !== true &&
    replyMetadata?.deliverDespiteSourceReplySuppression !== true &&
    ((!hasExplicitFailure && !heartbeatToolResponse) ||
      (agentRunFailed && !heartbeatTerminalToolFailure));
  if (heartbeatToolResponse && !heartbeatToolResponse.notify && !hasExplicitFailure) {
    return {
      kind: "ack",
      eventStatus: "ok-token",
      preview: truncateHeartbeatPreview(heartbeatToolResponse.summary),
      response: heartbeatToolResponse,
    } as const;
  }
  if (shouldSuppressSourceReply && !hasExplicitFailure) {
    // Message-tool privacy never makes an ordinary assistant final outbound;
    // marked operator notices and terminal failures keep their visible paths.
    return { kind: "ack", eventStatus: "ok-token", silent: true } as const;
  }
  if (
    !heartbeatToolResponse &&
    !hasExplicitFailure &&
    (!replyPayload || !hasOutboundReplyContent(replyPayload))
  ) {
    return { kind: "ack", eventStatus: "ok-empty" } as const;
  }
  const mode = params.hasRelayableExecCompletion ? "message" : "heartbeat";
  const normalized =
    heartbeatToolResponse && !shouldSuppressSourceReply && !(hasExplicitFailure && replyPayload)
      ? normalizeHeartbeatToolNotification(heartbeatToolResponse, params.responsePrefix)
      : normalizeHeartbeatReply(
          shouldSuppressSourceReply ? {} : (replyPayload ?? {}),
          params.responsePrefix,
          params.ackMaxChars,
          mode,
        );
  if (agentRunFailed) {
    const replacement = replaceGenericExternalRunFailureText(normalized.text);
    if (replacement.replaced) {
      normalized.text = replacement.text;
      normalized.shouldSkip = false;
    }
  }
  const hasStructuredReplyContent =
    !shouldSuppressSourceReply &&
    (!heartbeatToolResponse || agentRunFailed) &&
    replyPayload !== undefined &&
    hasOutboundReplyContent({
      ...replyPayload,
      text: undefined,
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  const shouldSkipMain =
    normalized.shouldSkip &&
    !normalized.hasMedia &&
    (!hasStructuredReplyContent || normalized.isInternalPlaceholderOnly);
  if (hasExplicitFailure) {
    return {
      kind: "failure",
      reason: heartbeatTerminalToolFailure ? "agent-tool-failure" : "agent-runner-failure",
      ...(heartbeatTerminalToolFailure
        ? {
            previewText: heartbeatToolResponse?.summary || heartbeatTerminalToolFailure.toolName,
          }
        : {}),
      replyPayload: shouldSuppressSourceReply ? undefined : replyPayload,
      normalized,
      shouldSkipMain,
    } as const;
  }
  if (shouldSkipMain) {
    // A heartbeat's canonical quiet reply still honors explicit showOk; event
    // relays and message-tool privacy retain their unconditional silence.
    const silent =
      normalized.silent && !(mode === "heartbeat" && isSilentReplyPayloadText(replyPayload?.text));
    return { kind: "ack", eventStatus: "ok-token", silent } as const;
  }
  return {
    kind: "delivery",
    response: heartbeatToolResponse,
    normalized,
    hasStructuredReplyContent,
    replyPayload: heartbeatToolResponse ? undefined : replyPayload,
    mediaUrls:
      heartbeatToolResponse || !replyPayload
        ? []
        : resolveSendableOutboundReplyParts(replyPayload).mediaUrls,
  } as const;
}
