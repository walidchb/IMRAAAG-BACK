> ## Documentation Index
> Fetch the complete documentation index at: https://docs.zrexpress.app/llms.txt
> Use this file to discover all available pages before exploring further.

# Gets a list of territories

Gets a list of territories with pagination and filtering support

***

> ##### *Please note that the Territory object includes a DeliveryCapability attribute, which indicates the delivery options available for the given territory (home delivery and/or pickup point).*

***

> ## Path Parameters

| Name    | Type   | Required | Description                                 |
| ------- | ------ | -------- | ------------------------------------------- |
| version | string | Yes      | Defaults to `1`. The requested API version. |

> ## Headers

| Name      | Type   | Required | Description                                                                                                                      |
| --------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| X-Tenant  | string | Yes      | Tenant ID required to access this API.                                                                                           |
| X-Api-Key | string | Yes      | API key required for authentication. To see how to get it, check this [guide](https://docs.zrexpress.app/docs/authentication#/). |

> ## Body Parameters

* **advancedSearch**:  An object that allows specifying multiple fields to search within and a keyword to match.
  * **fields**: List of field names to search in.
  * **keyword**: The search term to look for.

* **keyword**: A general search term applied across default searchable fields.

* **advancedFilter**:  An object defining more complex filter conditions.
  * **logic**: The logical operator to combine multiple filters.
  * **filters**: An array of nested filter conditions.
  * **field**: The specific field to apply the filter on.
  * **operator**: The comparison type.
  * **value**: The value to compare against.

* **pageNumber**: The index of the current results page.

* **pageSize**: The number of records to return per page.

* **orderBy**: A list of fields to sort results by, optionally with a direction.

> ## Response

**Status 200 OK**

| Field       | Type             | Description                                  |
| :---------- | :--------------- | :------------------------------------------- |
| items       | array of objects | List of territories matching the query.      |
| pageNumber  | int32            | Current page number.                         |
| pageSize    | int32            | Number of items returned per page.           |
| totalCount  | int32            | Total number of products matching the query. |
| totalPages  | int32            | Total number of available pages.             |
| hasPrevious | boolean          | Indicates if there is a previous page.       |
| hasNext     | boolean          | Indicates if there is a next page.           |

> Note: If any attribute is null, it will be ignored and not included in the API response.

<Table align={["left","left","left"]}>
  <thead>
    <tr>
      <th>
        Name
      </th>

      <th>
        Type
      </th>

      <th>
        Description
      </th>
    </tr>
  </thead>

  <tbody>
    <tr>
      <td>
        id
      </td>

      <td>
        uuid
      </td>

      <td>
        ID of the territory.
      </td>
    </tr>

    <tr>
      <td>
        code
      </td>

      <td>
        int32
      </td>

      <td>
        Code of the territory.
      </td>
    </tr>

    <tr>
      <td>
        name
      </td>

      <td>
        string
      </td>

      <td>
        Name of the territory.
      </td>
    </tr>

    <tr>
      <td>
        PostalCode
      </td>

      <td>
        string
      </td>

      <td>
        Postal code of the territory.
      </td>
    </tr>

    <tr>
      <td>
        level
      </td>

      <td>
        string
      </td>

      <td>
        Level of the territory (wilaya/ commune)
      </td>
    </tr>

    <tr>
      <td>
        parentId
      </td>

      <td>
        uuid
      </td>

      <td>
        ID of the parent territory.
      </td>
    </tr>

    <tr>
      <td>
        DeliveryCapability
      </td>

      <td>
        object
      </td>

      <td>
        Represents the delivery options available for a given territory.
      </td>
    </tr>

    <tr>
      <td>
        DeliveryCapability.  HasHomeDelivery
      </td>

      <td>
        bool
      </td>

      <td>
        Indicates whether home delivery is available in this territory.
      </td>
    </tr>

    <tr>
      <td>
        DeliveryCapability  
        .HasPickupPoint
      </td>

      <td>
        bool
      </td>

      <td>
        Indicates whether pickup point delivery is available in this territory.
      </td>
    </tr>
  </tbody>
</Table>

> ## Example Request

```bash
curl -X 'POST' \
  'https://api.zrexpress.app/api/v1.0/territories/search' \
  -H 'accept: application/json' \
  -H 'X-Tenant: YOUR-TENANT-ID' \
  -H "X-Api-Key: YOUR-API-KEY"
  -H 'Content-Type: application/json' \
  -d '{
  "pageNumber": 1,
  "pageSize": 5000,
  "orderBy": [
    "code asc"
  ]
}'
```

> ## Example Response

```json
{
  "items": [
    {
      "id": "6e978fc5-f20a-4b5f-9adf-61dd21a7672a",
      "code": 25,
      "name": "Constantine",
      "postalCode": "25000",
      "level": "wilaya",
      "parentId": null,
      "delivery": {
        "hasHomeDelivery": true,
        "hasPickupPoint": false
      }
    }
  ],
  "pageNumber": 1,
  "pageSize": 5000,
  "totalCount": 1,
  "totalPages": 1,
  "hasPrevious": false,
  "hasNext": false
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
    "/api/v{version}/territories/search": {
      "post": {
        "tags": [
          "orders"
        ],
        "summary": "Gets a list of territories",
        "description": "Gets a list of territories with pagination and filtering support",
        "operationId": "SearchTerritoriesEndpoint",
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
                "$ref": "#/components/schemas/SearchTerritoriesRequest"
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
                  "$ref": "#/components/schemas/PagedList_TerritoryResponse"
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
      "DeliveryCapability": {
        "type": "object",
        "properties": {
          "hasHomeDelivery": {
            "type": "boolean"
          },
          "hasPickupPoint": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "DeliveryType": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "nullable": true,
            "readOnly": true
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
      "PagedList_TerritoryResponse": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/TerritoryResponse"
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
      "SearchTerritoriesRequest": {
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
          "expiration": {
            "type": "string",
            "format": "date-span",
            "nullable": true,
            "readOnly": true
          },
          "id": {
            "type": "string",
            "format": "uuid",
            "nullable": true
          },
          "deliveryType": {
            "$ref": "#/components/schemas/DeliveryType"
          },
          "includeUnavailable": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "TerritoryResponse": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "code": {
            "type": "integer",
            "format": "int32"
          },
          "name": {
            "type": "string",
            "nullable": true
          },
          "postalCode": {
            "type": "string",
            "nullable": true
          },
          "level": {
            "type": "string",
            "nullable": true
          },
          "parentId": {
            "type": "string",
            "format": "uuid",
            "nullable": true
          },
          "delivery": {
            "$ref": "#/components/schemas/DeliveryCapability"
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