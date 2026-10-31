import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { isProduction } from '../config/env.js';

export type MailTemplate =
  | { template: 'verify-email'; url: string }
  | { template: 'reset-password'; url: string }
  | { template: 'otp'; otp: string; type: string }
  | { template: 'invitation'; url: string; tenantName: string; inviterName: string }
  | { template: 'welcome'; tenantName: string; appUrl: string };

/**
 * Envío de correo con dos proveedores y un motivo para cada uno:
 *
 *  - `gmail`: mientras no haya dominio propio. SMTP de Gmail con contraseña de aplicación, límite
 *    real ~500 destinatarios/día. Suficiente para invitaciones y recuperaciones de una bodega.
 *  - `resend`: cuando el dominio esté verificado en Cloudflare. Mejor entregabilidad y sin límite
 *    de Gmail, pero exige DNS.
 *  - `log`: desarrollo y tests. Nunca se envía nada, solo se registra.
 *
 * El proveedor se elige por `MAIL_PROVIDER`, así que migrar a dominio propio es cambiar una
 * variable, no reescribir el código que manda correos.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly log = new Logger(MailService.name);

  /**
   * Aviso de arranque, no de envío.
   *
   * Si el proveedor está en `log`, la aplicación funciona y los correos **no salen**: invitaciones y
   * recuperación de contraseña se pierden sin que nadie vea un error. Eso ya pasó una vez y se
   * descubrió cuando un cliente pidió su enlace. Por eso se dice al arrancar, en el log del
   * servicio, que es donde se mira cuando algo no llega.
   */
  onModuleInit() {
    const provider = process.env.MAIL_PROVIDER ?? 'log';
    if (provider === 'log') {
      const message =
        'MAIL_PROVIDER=log: los correos NO se envían (solo se escriben aquí). ' +
        'Invitaciones y recuperación de contraseña no llegan al destinatario.';
      if (isProduction) this.log.error(message);
      else this.log.warn(message);
      return;
    }
    if (provider === 'resend' && !process.env.RESEND_API_KEY) {
      this.log.error('MAIL_PROVIDER=resend sin RESEND_API_KEY: todo envío va a fallar.');
      return;
    }
    if (provider === 'gmail' && !(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)) {
      this.log.error('MAIL_PROVIDER=gmail sin GMAIL_USER/GMAIL_APP_PASSWORD: todo envío va a fallar.');
      return;
    }
    this.log.log(`Correo saliendo por ${provider}`);
  }

  async send(to: string, message: MailTemplate): Promise<void> {
    const provider = process.env.MAIL_PROVIDER ?? 'log';
    const subject = this.subjectFor(message);
    const text = this.textFor(message);

    if (provider === 'log') {
      this.log.log(`[correo simulado] ${subject} → ${to}`);
      return;
    }

    if (provider === 'resend') {
      await this.sendResend(to, subject, text);
      return;
    }

    await this.sendGmail(to, subject, text);
  }

  private subjectFor(m: MailTemplate): string {
    switch (m.template) {
      case 'verify-email':
        return 'Confirma tu correo en PartOps';
      case 'reset-password':
        return 'Restablece tu contraseña de PartOps';
      case 'otp':
        return `Tu código de PartOps: ${m.otp}`;
      case 'invitation':
        return `${m.inviterName} te invitó a ${m.tenantName} en PartOps`;
      case 'welcome':
        return `Bienvenido a PartOps, ${m.tenantName}`;
    }
  }

  /** Texto plano a propósito: llega a cualquier cliente, no cae en spam y no depende de imágenes. */
  private textFor(m: MailTemplate): string {
    switch (m.template) {
      case 'verify-email':
        return `Confirma tu correo para activar tu cuenta de PartOps:\n\n${m.url}\n\nEl enlace vence en 1 hora.`;
      case 'reset-password':
        return `Alguien pidió restablecer tu contraseña de PartOps.\n\n${m.url}\n\nSi no fuiste tú, ignora este correo: tu contraseña no cambia.`;
      case 'otp':
        return `Tu código de verificación es ${m.otp}.\n\nVence en 10 minutos. No lo compartas con nadie.`;
      case 'invitation':
        return `${m.inviterName} te invitó a unirte a ${m.tenantName} en PartOps.\n\n${m.url}\n\nEl enlace vence en 7 días.`;
      case 'welcome':
        return `Tu bodega ${m.tenantName} ya está en PartOps.\n\nEntra aquí: ${m.appUrl}\n\nPrimer paso: importa tu catálogo desde Excel.`;
    }
  }

  private async sendResend(to: string, subject: string, text: string) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      this.log.error('MAIL_PROVIDER=resend sin RESEND_API_KEY: el correo no se envía');
      throw new Error('Correo no configurado');
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM ?? 'PartOps <partopsgt@gmail.com>',
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      // El cuerpo del error de Resend dice si es dominio sin verificar, cuota o destinatario inválido.
      this.log.error(`Resend rechazó el envío: ${res.status} ${await res.text()}`);
      throw new Error('No se pudo enviar el correo');
    }
  }

  /**
   * Gmail por SMTP.
   *
   * Es el proveedor que se usa mientras `partops.autos` no esté verificado: el correo sale como
   * `partopsgt@gmail.com` y el cliente lo ve raro, pero **llega**. Fingir éxito aquí es peor que
   * fallar: la pantalla de invitación diría "enviada" y el vendedor nunca recibiría nada.
   *
   * Se abre un transporte por envío y se cierra: el volumen es de decenas de correos al mes, y un
   * pool persistente en una instancia que se duerme en Render deja sockets muertos.
   */
  private async sendGmail(to: string, subject: string, text: string) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      this.log.error('MAIL_PROVIDER=gmail sin GMAIL_USER/GMAIL_APP_PASSWORD: el correo no se envía');
      throw new Error('Correo no configurado');
    }

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });

    try {
      await transport.sendMail({
        from: process.env.MAIL_FROM ?? `PartOps <${user}>`,
        to,
        subject,
        text,
      });
    } catch (err) {
      // El error típico es 535 (contraseña de aplicación revocada) o 550 (remitente no permitido).
      this.log.error(`Gmail rechazó el envío: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error('No se pudo enviar el correo');
    } finally {
      transport.close();
    }
  }
}
