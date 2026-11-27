import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PlansService } from './plans.service';

@ApiTags('Plans')
@Controller('plans')
export class PublicPlansController {
  constructor(private readonly plansService: PlansService) {}

  @Public()
  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Public list of active subscription plans' })
  async list() {
    return { items: await this.plansService.listPublic() };
  }
}
