# Get effective delivery rates for all territories

Returns the effective delivery prices for all destination territories. This endpoint automatically applies the priority logic: supplier-specific prices take precedence over PriceList prices.

# OpenAPI definition

```json
{
  "openapi": "3.0.4",
  "info": {
    "title": "ZRExpress.Api",
    "description": "",
    "contact": {
      "name": "ZRExpress",
      "email": "support@zrexpress.net"
    },
    "version": "1"
  },
  "servers": [
    {
      "url": "https://api.zrexpress.app"
    }
  ],
  "paths": {
    "/api/v{version}/delivery-pricing/rates": {
      "get": {
        "tags": [
          "rates"
        ],
        "summary": "Get effective delivery rates for all territories",
        "description": "Returns the effective delivery prices for all destination territories. This endpoint automatically applies the priority logic: supplier-specific prices take precedence over PriceList prices.",
        "operationId": "GetAllRatesEndpoint",
        "parameters": [
          {
            "name": "version",
            "in": "path",
            "description": "The requested API version",
            "required": true,
            "schema": {
              "type": "string",
              "default": "1"
            }
          },
          {
            "name": "X-Tenant",
            "in": "header",
            "description": "Input your tenant Id to access this API",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GetAllRatesResponse"
                }
              }
            }
          },
          "404": {
            "description": "Not Found",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/ProblemDetails"
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "DeliveryPriceDto": {
        "type": "object",
        "properties": {
          "deliveryType": {
            "type": "string",
            "nullable": true
          },
          "price": {
            "type": "number",
            "format": "double"
          }
        },
        "additionalProperties": false
      },
      "GetAllRatesResponse": {
        "type": "object",
        "properties": {
          "rates": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/TerritoryRateDto"
            },
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "ProblemDetails": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "nullable": true
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "integer",
            "format": "int32",
            "nullable": true
          },
          "detail": {
            "type": "string",
            "nullable": true
          },
          "instance": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": {}
      },
      "TerritoryRateDto": {
        "type": "object",
        "properties": {
          "toTerritoryId": {
            "type": "string",
            "format": "uuid"
          },
          "toTerritoryCode": {
            "type": "integer",
            "format": "int32",
            "nullable": true
          },
          "toTerritoryName": {
            "type": "string",
            "nullable": true
          },
          "toTerritoryLevel": {
            "type": "string",
            "nullable": true
          },
          "deliveryPrices": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/DeliveryPriceDto"
            },
            "nullable": true
          }
        },
        "additionalProperties": false
      }
    },
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "description": "Enter your token in the text input below.\r\n\r\nExample: \"ejlklm533123\" without Bearer prefix",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      },
      "apiKey": {
        "type": "apiKey",
        "description": "API Key Authentication\r\n\r\nEnter your API key in the format: \"X-Api-Key: your-api-key\"",
        "name": "X-Api-Key",
        "in": "header"
      }
    }
  },
  "security": [
    {
      "bearerAuth": [],
      "apiKey": []
    }
  ]
}
```