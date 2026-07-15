import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class AppController {
  @Get()
  @ApiOperation({ summary: 'API health check' })
  @ApiResponse({ status: 200, description: 'API is running' })
  getHealth() {
    return {
      status: 'ok',
      message: 'Imraaah API is running',
      timestamp: new Date().toISOString(),
    };
  }
}
