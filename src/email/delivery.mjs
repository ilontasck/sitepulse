export class EmailDeliveryError extends Error{constructor({code="EMAIL_DELIVERY_FAILED",retryable=true}={}){super("Email delivery failed.");this.code=/^[A-Z][A-Z0-9_]{0,63}$/.test(code)?code:"EMAIL_DELIVERY_FAILED";this.retryable=retryable;}}
export function createDisabledEmailAdapter(){return{enabled:false,async send(){throw new EmailDeliveryError({code:"EMAIL_DELIVERY_DISABLED",retryable:false});}}}
export function createEmailService({adapter=createDisabledEmailAdapter(),publicOrigin,maxImmediateAttempts=2,telemetry}={}){
  const link=(fragment,token)=>`${publicOrigin}/#${fragment}=${token}`;
  async function deliver(message,kind){let last;for(let attempt=1;attempt<=maxImmediateAttempts;attempt++){try{await adapter.send(message);return true}catch(error){last=error;if(error?.retryable===false)break;}}telemetry?.record("email.delivery_failed",{kind,outcome:"failure",errorCode:last?.code||"EMAIL_DELIVERY_FAILED"});return false;}
  return{
    enabled:adapter.enabled!==false,
    deliverPasswordReset:({email,token})=>deliver({to:email,subject:"Reset your password",text:`Reset your password: ${link("reset-password",token)}`,html:`<p>Reset your password:</p><p><a href="${link("reset-password",token)}">Reset password</a></p>`,idempotencyKey:null},"password_reset"),
    deliverEmailVerification:({email,token})=>deliver({to:email,subject:"Verify your email",text:`Verify your email: ${link("verify-email",token)}`,html:`<p>Verify your email:</p><p><a href="${link("verify-email",token)}">Verify email</a></p>`,idempotencyKey:null},"email_verification"),
    adapter
  };
}
