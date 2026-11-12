import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StoresModule } from '../stores/stores.module';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { StoreMember, StoreMemberSchema } from './schemas/store-member.schema';
import {
  StoreInvitation,
  StoreInvitationSchema,
} from './schemas/store-invitation.schema';
import { StoreAccessService } from './store-access.service';
import { PermissionsGuard } from './permissions.guard';
import { TeamService } from './team.service';
import { InvitationsService } from './invitations.service';
import { TeamController } from './team.controller';

/**
 * Team Management: memberships, invitations, access primitives and the team API.
 *
 * It imports `StoresModule` (owner-or-member lookups), `AuditModule`, `EmailModule` and the
 * `User` model — never `AuthModule` — so the `AuthModule → TeamModule` dependency (B4 uses the
 * invitation service) stays acyclic.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StoreMember.name, schema: StoreMemberSchema },
      { name: StoreInvitation.name, schema: StoreInvitationSchema },
      { name: User.name, schema: UserSchema },
    ]),
    StoresModule,
    AuditModule,
    EmailModule,
  ],
  controllers: [TeamController],
  providers: [StoreAccessService, PermissionsGuard, TeamService, InvitationsService],
  exports: [
    StoreAccessService,
    PermissionsGuard,
    TeamService,
    InvitationsService,
    MongooseModule,
  ],
})
export class TeamModule {}
