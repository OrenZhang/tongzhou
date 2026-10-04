/** Explicit provider settings keep WS first while bounding failed handshakes. */
export function codexTransportArgs(transport: 'http' | 'auto' = 'auto') {
  const provider = `tongzhou_chatgpt_${transport}`;
  return [
    `model_provider="${provider}"`,
    `model_providers.${provider}.name="OpenAI"`,
    `model_providers.${provider}.base_url="https://chatgpt.com/backend-api/codex"`,
    `model_providers.${provider}.wire_api="responses"`,
    `model_providers.${provider}.requires_openai_auth=true`,
    `model_providers.${provider}.supports_websockets=${transport === 'auto'}`,
    `model_providers.${provider}.supports_standalone_web_search=true`,
    ...(transport === 'auto'
      ? [
          `model_providers.${provider}.websocket_connect_timeout_ms=4000`,
          `model_providers.${provider}.stream_max_retries=1`,
        ]
      : []),
  ].flatMap((value) => ['-c', value]);
}
