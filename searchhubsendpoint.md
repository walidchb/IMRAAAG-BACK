# Get a list of hubs

Get a list of hubs with pagination and filtering support

> ## Path Parameters

| Name    | Type   | Required | Description                              |
| ------- | ------ | -------- | ---------------------------------------- |
| version | string | Yes      | The requested API version (default: `1`) |

> ## Headers

| Name      | Type   | Required | Description                                                                                                                      |
| :-------- | :----- | :------- | :------------------------------------------------------------------------------------------------------------------------------- |
| X-Tenant  | string | Yes      | Tenant ID required to access this API.                                                                                           |
| X-Api-Key | string | Yes      | API key required for authentication. To see how to get it, check this [guide](https://docs.zrexpress.app/docs/authentication#/). |

> ## Request Body Parameters

### Fields Explanation

* **advancedSearch**:
  An object that allows specifying multiple fields to search within and a keyword to match.
* **fields**: List of field names to search in.
* **keyword**: The search term to look for.
* **keyword**:
  A general search term applied across default searchable fields.
* **advancedFilter**:
  An object defining complex filter conditions.
  * **logic**: The logical operator to combine multiple filters, e.g., `"AND"` or `"OR"`.
  * **filters**: An array of nested filter conditions.
  * **field**: The specific field to apply the filter on.
  * **operator**: The comparison type, e.g., `"equals"`, `"contains"`, `"greaterThan"`.
  * **value**: The value to compare against.
* **pageNumber**:
  The index of the current results page.
* **pageSize**:
  The number of records to return per page.
* **orderBy**:
  A list of fields to sort results by, optionally with a direction. Example: `["Price desc", "Name asc"]`.

> ## Request Example

```bash
curl -X 'POST' \
  'https://api.zrexpress.app/api/v1/hubs/search' \
  -H 'accept: application/json' \
  -H 'X-Tenant: YOUR-TENANT-ID' \
  -H 'X-Api-Key: YOUR-API-KEY' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

> ## Response

If the hubs are successfully retrieved, you will receive a **200 OK** response containing a list of hub items with pagination details.

#### Status `200 OK` Response Body

| Field       | Type             | Description                                |
| :---------- | :--------------- | :----------------------------------------- |
| items       | array of objects | List of hubs matching the query            |
| pageNumber  | int32            | Current page number.                       |
| pageSize    | int32            | Number of items returned per page.         |
| totalCount  | int32            | Total number of claims matching the query. |
| totalPages  | int32            | Total number of available pages.           |
| hasPrevious | boolean          | Indicates if there is a previous page.     |
| hasNext     | boolean          | Indicates if there is a next page.         |

| Name                | Type      | Description                                                          |
| ------------------- | --------- | -------------------------------------------------------------------- |
| id                  | uuid      | The unique identifier of the hub.                                    |
| name                | string    | The name of the hub (nullable).                                      |
| type                | string    | The type of the hub (nullable).                                      |
| IsPickupPoint       | bool      | Indicates whether the hub can be used as a pickup point for parcels. |
| address             | object    | The hub address object.                                              |
| street              | string    | Street of the hub (nullable).                                        |
| city                | string    | City of the hub (nullable).                                          |
| cityTerritoryId     | uuid      | City territory identifier.                                           |
| district            | string    | District of the hub (nullable).                                      |
| districtTerritoryId | uuid      | District territory identifier.                                       |
| postalCode          | string    | Postal code of the hub (nullable).                                   |
| country             | string    | Country of the hub (nullable).                                       |
| coordinates         | object    | The latitude and longitude object.                                   |
| lat                 | double    | Latitude of the hub (nullable).                                      |
| lng                 | double    | Longitude of the hub (nullable).                                     |
| openingHours        | string    | Opening hours (nullable).                                            |
| phone               | object    | Phone numbers object.                                                |
| number1             | string    | Primary phone number (nullable).                                     |
| number2             | string    | Secondary phone number (nullable).                                   |
| number3             | string    | Tertiary phone number (nullable).                                    |
| createdAt           | date-time | Hub creation date and time.                                          |

#### Example Response

```json
{
  "items": [
    {
      "id": "31eee03e-2416-4116-9f16-15cc82059311",
      "name": "test",
      "type": "sorting-center-hub",
      "address": {
        "street": "test",
        "city": "Alger",
        "cityTerritoryId": "d134c182-7dac-4655-9d9b-bbdb62aa2ec4",
        "district": "Reghaia",
        "districtTerritoryId": "ff17d058-ac0d-4d6f-bfcf-7d38ba1124dd",
        "postalCode": "16036",
        "country": "algeria",
        "coordinates": {
          "lat": 36.73931757148507,
          "lng": 3.3389344811439514
        }
      },
      "openingHours": "08:30-16:30",
      "phone": {
        "number1": "+21355555555",
        "number2": "",
        "number3": ""
      },
      "createdAt": "2025-07-29T11:43:56.3298507+00:00"
    },
    {
      "id": "1168fe79-11e8-4142-8eed-196911e1c995",
      "name": "Bureau Khroub",
      "type": "stopdesk",
      "address": {
        "street": "Cité 1013 logements",
        "city": "Constantine",
        "cityTerritoryId": "e9a1e9cf-8475-4768-94cc-0888d094ff47",
        "district": "El Khroub",
        "districtTerritoryId": "07eb43c2-c141-48cd-8334-661717d8d3f0",
        "postalCode": "25105",
        "country": "algeria",
        "coordinates": {
          "lat": 36.26175808955952,
          "lng": 6.68970823287964
        }
      },
      "openingHours": "08:30-16:30",
      "phone": {
        "number1": "+21355778899",
        "number2": "",
        "number3": ""
      },
      "createdAt": "2025-07-28T09:59:08.5776314+00:00"
    }
  ],
  "pageNumber": 1,
  "pageSize": 2,
  "totalCount": 11,
  "totalPages": 6,
  "hasPrevious": false,
  "hasNext": true
}
```

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
    "/api/v{version}/hubs/search": {
      "post": {
        "tags": [
          "hubs"
        ],
        "summary": "Get a list of hubs",
        "description": "Get a list of hubs with pagination and filtering support",
        "operationId": "SearchHubsEndpoint",
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
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/SearchHubsRequest"
              }
            }
          },
          "required": true
        },
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PagedList_HubResponse"
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
      "AddressDto": {
        "type": "object",
        "properties": {
          "street": {
            "type": "string",
            "nullable": true
          },
          "city": {
            "type": "string",
            "nullable": true
          },
          "cityTerritoryId": {
            "type": "string",
            "format": "uuid"
          },
          "district": {
            "type": "string",
            "nullable": true
          },
          "districtTerritoryId": {
            "type": "string",
            "format": "uuid"
          },
          "postalCode": {
            "type": "string",
            "nullable": true
          },
          "country": {
            "type": "string",
            "nullable": true
          },
          "coordinates": {
            "$ref": "#/components/schemas/Coordinates"
          }
        },
        "additionalProperties": false
      },
      "Coordinates": {
        "type": "object",
        "properties": {
          "lat": {
            "type": "number",
            "format": "double",
            "nullable": true
          },
          "lng": {
            "type": "number",
            "format": "double",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "Filter": {
        "type": "object",
        "properties": {
          "logic": {
            "type": "string",
            "nullable": true
          },
          "filters": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/Filter"
            },
            "nullable": true
          },
          "field": {
            "type": "string",
            "nullable": true
          },
          "operator": {
            "type": "string",
            "nullable": true
          },
          "value": {
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "HubResponse": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "name": {
            "type": "string",
            "nullable": true
          },
          "type": {
            "type": "string",
            "nullable": true
          },
          "isPickupPoint": {
            "type": "boolean"
          },
          "address": {
            "$ref": "#/components/schemas/AddressDto"
          },
          "openingHours": {
            "type": "string",
            "nullable": true
          },
          "phone": {
            "$ref": "#/components/schemas/PhoneDto"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "services": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/HubServiceDto"
            },
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "HubServiceDto": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "type": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "PagedList_HubResponse": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/HubResponse"
            },
            "nullable": true
          },
          "pageNumber": {
            "type": "integer",
            "format": "int32"
          },
          "pageSize": {
            "type": "integer",
            "format": "int32"
          },
          "totalCount": {
            "type": "integer",
            "format": "int32"
          },
          "totalPages": {
            "type": "integer",
            "format": "int32",
            "readOnly": true
          },
          "hasPrevious": {
            "type": "boolean",
            "readOnly": true
          },
          "hasNext": {
            "type": "boolean",
            "readOnly": true
          }
        },
        "additionalProperties": false
      },
      "PhoneDto": {
        "type": "object",
        "properties": {
          "number1": {
            "type": "string",
            "nullable": true
          },
          "number2": {
            "type": "string",
            "nullable": true
          },
          "number3": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "Search": {
        "type": "object",
        "properties": {
          "fields": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "keyword": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "SearchHubsRequest": {
        "type": "object",
        "properties": {
          "advancedSearch": {
            "$ref": "#/components/schemas/Search"
          },
          "keyword": {
            "type": "string",
            "nullable": true
          },
          "advancedFilter": {
            "$ref": "#/components/schemas/Filter"
          },
          "pageSize": {
            "maximum": 1000,
            "minimum": 1,
            "type": "integer",
            "format": "int32"
          },
          "pageNumber": {
            "maximum": 2147483647,
            "minimum": 1,
            "type": "integer",
            "format": "int32"
          },
          "orderBy": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "onlySortingCentersWhenAvailable": {
            "type": "boolean",
            "nullable": true
          },
          "includeServices": {
            "type": "boolean"
          },
          "services": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "expiration": {
            "type": "string",
            "format": "date-span",
            "nullable": true,
            "readOnly": true
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