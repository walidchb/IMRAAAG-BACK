import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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
      this.logger.warn('SMTP not configured. Emails will be logged instead of sent.');
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
        this.logger.error(`Failed to send email to ${to}: ${err instanceof Error ? err.stack || err.message : String(err)}`);
        this.logger.log(`[EMAIL FALLBACK] To: ${to} | Reset URL: ${resetUrl}`);
      }
    } else {
      this.logger.log(`[EMAIL LOG] To: ${to} | Subject: ${subject} | Reset URL: ${resetUrl}`);
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
}
