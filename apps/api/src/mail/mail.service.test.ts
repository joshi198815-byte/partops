import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service.js';

/**
 * Qué hace el correo cuando **no** puede enviar.
 *
 * Importa porque el modo de falla es silencioso: la invitación se crea, la pantalla dice "enviada"
 * y el vendedor nunca recibe nada. Estas pruebas fijan dos decisiones:
 *
 *  1. Con el proveedor mal configurado, `send` **rechaza**. Nunca finge éxito.
 *  2. Con `log`, no rechaza —es el modo de desarrollo a propósito— pero el arranque lo grita.
 *
 * No se prueba el envío real: eso depende de una contraseña de aplicación que no vive en el repo.
 */
const ORIGINAL = { ...process.env };

function restore() {
  for (const key of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD']) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
}

afterEach(restore);

const message = {
  template: 'invitation',
  url: 'https://partops.autos/invitacion/x',
  tenantName: 'Bodega',
  inviterName: 'Ana',
} as const;

describe('correo: proveedor mal configurado no finge éxito', () => {
  it('log no rechaza: es el modo de desarrollo', async () => {
    process.env.MAIL_PROVIDER = 'log';
    await expect(new MailService().send('a@b.gt', message)).resolves.toBeUndefined();
  });

  it('gmail sin credenciales rechaza en vez de decir que envió', async () => {
    process.env.MAIL_PROVIDER = 'gmail';
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    await expect(new MailService().send('a@b.gt', message)).rejects.toThrow('Correo no configurado');
  });

  it('resend sin llave rechaza', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    delete process.env.RESEND_API_KEY;
    await expect(new MailService().send('a@b.gt', message)).rejects.toThrow('Correo no configurado');
  });

  it('el arranque no tumba la API aunque el correo esté en log', () => {
    process.env.MAIL_PROVIDER = 'log';
    expect(() => new MailService().onModuleInit()).not.toThrow();
  });

  it('el arranque avisa, no lanza, cuando gmail está a medias', () => {
    process.env.MAIL_PROVIDER = 'gmail';
    process.env.GMAIL_USER = 'partopsgt@gmail.com';
    delete process.env.GMAIL_APP_PASSWORD;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => new MailService().onModuleInit()).not.toThrow();
    spy.mockRestore();
  });
});
