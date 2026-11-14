import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { AppLocale, normalizeLocale } from '../../common/constants/locales.const';
import { StoreRole } from '../../common/constants/store-roles.enum';

interface TeamInvitationCopy {
  dir: 'ltr' | 'rtl';
  subject: (storeName: string) => string;
  heading: string;
  intro: (invitedByName: string, storeName: string, roleLabel: string) => string;
  instructions: string;
  button: string;
  expiry: (hours: number) => string;
  roles: Record<StoreRole, string>;
}

const TEAM_INVITATION_COPY: Record<AppLocale, TeamInvitationCopy> = {
  en: {
    dir: 'ltr',
    subject: (storeName) => `You have been invited to join ${storeName} on Imraaah`,
    heading: 'You are invited to join a store team',
    intro: (invitedByName, storeName, roleLabel) =>
      `${invitedByName} invited you to join <strong>${storeName}</strong> as <strong>${roleLabel}</strong>.`,
    instructions:
      'Click the button below to accept the invitation. If you do not yet have an Imraaah account, you will set your own password first — we never email passwords.',
    button: 'Accept Invitation',
    expiry: (hours) =>
      `This invitation expires in ${hours} hours. If you were not expecting it, you can ignore this email.`,
    roles: {
      [StoreRole.OWNER]: 'Owner',
      [StoreRole.PARTNER]: 'Partner',
      [StoreRole.ORDER_CONFIRMER]: 'Order Confirmer',
      [StoreRole.INVENTORY_STAFF]: 'Inventory Staff',
      [StoreRole.CASHIER]: 'Cashier',
    },
  },
  fr: {
    dir: 'ltr',
    subject: (storeName) => `Vous êtes invité à rejoindre ${storeName} sur Imraaah`,
    heading: "Vous êtes invité à rejoindre l'équipe d'une boutique",
    intro: (invitedByName, storeName, roleLabel) =>
      `${invitedByName} vous a invité à rejoindre <strong>${storeName}</strong> en tant que <strong>${roleLabel}</strong>.`,
    instructions:
      "Cliquez sur le bouton ci-dessous pour accepter l'invitation. Si vous n'avez pas encore de compte Imraaah, vous définirez d'abord votre mot de passe — nous n'envoyons jamais de mots de passe par e-mail.",
    button: "Accepter l'invitation",
    expiry: (hours) =>
      `Cette invitation expire dans ${hours} heures. Si vous ne l'attendiez pas, vous pouvez ignorer cet e-mail.`,
    roles: {
      [StoreRole.OWNER]: 'Propriétaire',
      [StoreRole.PARTNER]: 'Partenaire',
      [StoreRole.ORDER_CONFIRMER]: 'Confirmation des commandes',
      [StoreRole.INVENTORY_STAFF]: 'Gestion du stock',
      [StoreRole.CASHIER]: 'Caissier',
    },
  },
  ar: {
    dir: 'rtl',
    subject: (storeName) => `تمت دعوتك للانضمام إلى ${storeName} على Imraaah`,
    heading: 'تمت دعوتك للانضمام إلى فريق متجر',
    intro: (invitedByName, storeName, roleLabel) =>
      `دعاك ${invitedByName} للانضمام إلى <strong>${storeName}</strong> بصفة <strong>${roleLabel}</strong>.`,
    instructions:
      'اضغط على الزر أدناه لقبول الدعوة. إذا لم يكن لديك حساب Imraaah بعد، فستحدد كلمة المرور الخاصة بك أولاً — نحن لا نرسل كلمات المرور عبر البريد الإلكتروني.',
    button: 'قبول الدعوة',
    expiry: (hours) =>
      `تنتهي صلاحية هذه الدعوة خلال ${hours} ساعة. إذا لم تكن تتوقعها، يمكنك تجاهل هذا البريد.`,
    roles: {
      [StoreRole.OWNER]: 'المالك',
      [StoreRole.PARTNER]: 'شريك',
      [StoreRole.ORDER_CONFIRMER]: 'مؤكد الطلبات',
      [StoreRole.INVENTORY_STAFF]: 'موظف المخزون',
      [StoreRole.CASHIER]: 'أمين الصندوق',
    },
  },
};

function escapeHtml(value: string): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  );
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private configService: ConfigService) {
    const host = this.configService.get<string>('smtp.host');
    const port = this.configService.get<number>('smtp.port');
    const user = this.configService.get<string>('smtp.user');
    const pass = this.configService.get<string>('smtp.password');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port: port || 587,
        secure: port === 465,
        auth: { user, pass },
      });
    } else {
      this.logger.warn('SMTP not configured. Password reset emails cannot be delivered.');
    }
  }

  async sendPasswordResetEmail(to: string, resetUrl: string, expiresInMinutes: number): Promise<void> {
    const subject = 'Reset your Imraaah vendor password';
    const html = this.buildResetEmailTemplate(to, resetUrl, expiresInMinutes);

    if (this.transporter) {
      try {
        const from = this.configService.get<string>('smtp.from') || 'noreply@imraaah.ma';
        await this.transporter.sendMail({ from, to, subject, html });
        this.logger.log(`Password reset email sent to ${to}`);
      } catch (err) {
        // No reset URL in the log: a URL with a live token is a password-reset credential.
        // The correlation id is the recipient, so an operator can still find the failure.
        this.logger.error(
          `Password reset email delivery failed for ${to}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // SMTP is not configured (no provider, or a misconfiguration). Say so plainly and do
      // not print the reset URL — it would be the token, in plaintext, in a log. Password
      // reset requires a working mail provider in production.
      this.logger.error(
        '[EMAIL] SMTP is not configured; the password reset email was not sent.',
      );
    }
  }

  /**
   * Sends a store invitation.
   *
   * The raw token only ever appears inside the URL that is emailed. Callers must not log the
   * URL, the token, or its hash. Copy is rendered in the language the invitation was sent
   * from (English when no supported locale is supplied).
   *
   * @returns `true` when the message was accepted by the transport, `false` when SMTP is not
   *          configured or delivery failed. The invitation row is kept either way.
   */
  async sendTeamInvitationEmail(
    to: string,
    params: {
      storeName: string;
      role: string;
      invitedByName: string;
      acceptUrl: string;
      expiresInHours: number;
      locale?: AppLocale;
    },
  ): Promise<boolean> {
    const copy = TEAM_INVITATION_COPY[normalizeLocale(params.locale)];
    const subject = copy.subject(params.storeName);
    const html = this.buildTeamInvitationTemplate(to, params);

    if (!this.transporter) {
      this.logger.error(
        '[EMAIL] SMTP is not configured; the team invitation email was not sent.',
      );
      return false;
    }

    try {
      const from = this.configService.get<string>('smtp.from') || 'noreply@imraaah.ma';
      await this.transporter.sendMail({ from, to, subject, html });
      this.logger.log(`Team invitation email sent to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(
        `Team invitation email delivery failed for ${to}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private buildResetEmailTemplate(email: string, resetUrl: string, expiresInMinutes: number): string {
    return `
      <div style="font-family: 'Georgia', serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #F9F7F2; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 28px; color: #724444; letter-spacing: 0.3em; font-weight: bold;">IMRAAAH</span>
        </div>
        <h2 style="color: #724444; font-size: 18px; margin-bottom: 16px;">Reset Your Password</h2>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">
          You requested a password reset for your Imraaah vendor account.
        </p>
        <p style="color: #724444; font-size: 14px; line-height: 1.6; text-align: center; font-weight: bold;">
          ${email}
        </p>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">
          Click the button below to set a new password.
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #724444, #C5A059); color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: bold; letter-spacing: 0.05em;">
            Reset Password
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5;">
          This link expires in ${expiresInMinutes} minutes. If you did not request this, please ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
        <p style="color: #aaa; font-size: 11px; text-align: center;">
          Maison El Kahia &bull; Fès, Morocco
        </p>
      </div>
    `;
  }

  private buildTeamInvitationTemplate(
    email: string,
    params: {
      storeName: string;
      role: string;
      invitedByName: string;
      acceptUrl: string;
      expiresInHours: number;
      locale?: AppLocale;
    },
  ): string {
    const copy = TEAM_INVITATION_COPY[normalizeLocale(params.locale)];
    const roleLabel = copy.roles[params.role as StoreRole] ?? params.role;
    const invitedByName = escapeHtml(params.invitedByName);
    const storeName = escapeHtml(params.storeName);
    const acceptUrl = escapeHtml(params.acceptUrl);
    const recipient = escapeHtml(email);

    return `
      <div dir="${copy.dir}" style="font-family: 'Georgia', serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #F9F7F2; border-radius: 12px; text-align: start;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 28px; color: #724444; letter-spacing: 0.3em; font-weight: bold;">IMRAAAH</span>
        </div>
        <h2 style="color: #724444; font-size: 18px; margin-bottom: 16px;">${copy.heading}</h2>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">
          ${copy.intro(invitedByName, storeName, escapeHtml(roleLabel))}
        </p>
        <p style="color: #724444; font-size: 14px; line-height: 1.6; text-align: center; font-weight: bold;">
          ${recipient}
        </p>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">
          ${copy.instructions}
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${acceptUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #724444, #C5A059); color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: bold; letter-spacing: 0.05em;">
            ${copy.button}
          </a>
        </div>
        <p style="color: #888; font-size: 12px; line-height: 1.5;">
          ${copy.expiry(params.expiresInHours)}
        </p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
        <p style="color: #aaa; font-size: 11px; text-align: center;">
          Imraaah
        </p>
      </div>
    `;
  }
}
