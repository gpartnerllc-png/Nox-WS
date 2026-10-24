import { HttpError, str } from '../lib/http.js';

export function applePayStatus(env) {
  const merchantId = str(env.APPLE_PAY_MERCHANT_ID, 120);
  const domain = str(env.APPLE_PAY_DOMAIN, 180);
  const mtls = Boolean(env.APPLE_PAY_MTLS && typeof env.APPLE_PAY_MTLS.fetch === 'function');
  const association = Boolean(env.APPLE_PAY_DOMAIN_ASSOCIATION);
  return {
    configurado: Boolean(merchantId && domain && mtls),
    merchantId: merchantId || null,
    dominio: domain || null,
    certificadoMtls: mtls,
    domainAssociation: association,
    processador: Boolean(env.APPLE_PAY_PROCESSOR_URL),
    aviso:
      'Apple Pay exige Apple Developer Program, merchant identifier, domain verification e um PSP para processar o token. Nenhum dado de cartão é armazenado pelo NoxMob.',
  };
}

function validAppleValidationUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /^(apple-pay-gateway[\w-]*|apple-pay-gateway-cert[\w-]*)\.apple\.com$/i.test(url.hostname) &&
      url.pathname.startsWith('/paymentservices/')
    );
  } catch {
    return false;
  }
}

export async function startApplePaySession(env, input = {}) {
  const status = applePayStatus(env);
  if (!status.configurado) {
    throw new HttpError(
      503,
      'Apple Pay ainda não configurado. Envie merchant id, domínio e certificado mTLS ao Worker.',
      'APPLE_PAY_NOT_CONFIGURED',
      status
    );
  }
  const validationUrl = str(input.validationURL || input.validationUrl, 1000);
  if (!validAppleValidationUrl(validationUrl)) {
    throw new HttpError(400, 'URL de validação Apple inválida', 'INVALID_APPLE_URL');
  }
  const body = {
    merchantIdentifier: status.merchantId,
    domainName: status.dominio,
    displayName: str(input.displayName, 120) || 'NoxMob',
    initiative: 'web',
    initiativeContext: status.dominio,
  };
  const response = await env.APPLE_PAY_MTLS.fetch(validationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, `Apple Pay recusou a sessão: ${data?.message || response.status}`, 'APPLE_PAY_ERROR');
  }
  return { ok: true, session: data, status };
}
