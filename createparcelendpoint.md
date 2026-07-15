> ## Documentation Index
> Fetch the complete documentation index at: https://docs.zrexpress.app/llms.txt
> Use this file to discover all available pages before exploring further.

# Creates a parcel

Creates a parcel with products. The `StockType` parameter indicates the type of stock and accepts 'local', 'warehouse' or 'none'. Defaults to 'local' if not specified. The 'DeliveryType' parameter indicates the type of delivery and accepts 'home' or 'pickup-point'. Permissions requises : SupplierAdminRole, SupplierParcelsManagerRole.

***

**Permissions required:**  `SupplierParcelsManagerRole`, `SupplierAdminRole`.

***

> ## Path Parameters

| Name    | Type   | Required | Description                              |
| ------- | ------ | -------- | ---------------------------------------- |
| version | string | Yes      | The requested API version (default: `1`) |

> ## Headers

| Name      | Type   | Required | Description                                                                                                                      |
| :-------- | :----- | :------- | :------------------------------------------------------------------------------------------------------------------------------- |
| X-Tenant  | string | Yes      | Tenant ID required to access this API.                                                                                           |
| X-Api-Key | string | Yes      | API key required for authentication. To see how to get it, check this [guide](https://docs.zrexpress.app/docs/authentication#/). |

> ## Body Parameters

<Table align={["left","left","left","left"]}>
  <thead>
    <tr>
      <th>
        Field
      </th>

      <th>
        Type
      </th>

      <th>
        Required
      </th>

      <th>
        Description
      </th>
    </tr>
  </thead>

  <tbody>
    <tr>
      <td>
        **customer**
      </td>

      <td>
        object
      </td>

      <td>
        Yes
      </td>

      <td>
        Customer details
      </td>
    </tr>

    <tr>
      <td>
        customer.customerId
      </td>

      <td>
        uuid
      </td>

      <td>
        Yes
      </td>

      <td>
        Unique customer ID*. You can send a random UUID if you don’t want to associate the parcel with an existing customer.
      </td>
    </tr>

    <tr>
      <td>
        customer.name
      </td>

      <td>
        string
      </td>

      <td>
        Yes
      </td>

      <td>
        Customer name, must be between 2 and 100 characters
      </td>
    </tr>

    <tr>
      <td>
        customer.phone
      </td>

      <td>
        object
      </td>

      <td>
        Yes
      </td>

      <td>
        Phone details
      </td>
    </tr>

    <tr>
      <td>
        customer.phone.number1
      </td>

      <td>
        string
      </td>

      <td>
        Yes
      </td>

      <td>
        Primary phone number, required, and must be a valid international phone number
      </td>
    </tr>

    <tr>
      <td>
        customer.phone.number2
      </td>

      <td>
        string
      </td>

      <td>
        No
      </td>

      <td>
        Secondary phone number
      </td>
    </tr>

    <tr>
      <td>
        customer.phone.number3
      </td>

      <td>
        string
      </td>

      <td>
        No
      </td>

      <td>
        Tertiary phone number
      </td>
    </tr>

    <tr>
      <td>
        **deliveryAddress**
      </td>

      <td>
        object
      </td>

      <td>
        No
      </td>

      <td>
        Delivery address details
      </td>
    </tr>

    <tr>
      <td>
        deliveryAddress.
        cityTerritoryId
      </td>

      <td>
        uuid
      </td>

      <td>
        Yes
      </td>

      <td>
        City territory ID (wilaya Id)  
        [https://docs.zrexpress.app/reference/searchterritoriesendpoint#/](https://docs.zrexpress.app/reference/searchterritoriesendpoint#/)
      </td>
    </tr>

    <tr>
      <td>
        deliveryAddress
        .districtTerritoryId
      </td>

      <td>
        uuid
      </td>

      <td>
        Yes
      </td>

      <td>
        District territory ID (commune ID)  
        [https://docs.zrexpress.app/reference/searchterritoriesendpoint#/](https://docs.zrexpress.app/reference/searchterritoriesendpoint#/)
      </td>
    </tr>

    <tr>
      <td>
        deliveryAddress.Street
      </td>

      <td>
        string
      </td>

      <td>
        No
      </td>

      <td>
        The street information of the delivery address,
      </td>
    </tr>

    <tr>
      <td>
        **hubId**
      </td>

      <td>
        uuid
      </td>

      <td>
        No
      </td>

      <td>
        Hub identifier — required when delivery type is `pickup-point`
      </td>
    </tr>

    <tr>
      <td>
        **orderedProducts**
      </td>

      <td>
        array of objects
      </td>

      <td>
        Yes
      </td>

      <td>
        Ordered products list — at least one product must be ordered
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[].productId
      </td>

      <td>
        uuid
      </td>

      <td>
        No
      </td>

      <td>
        Product ID — required when `stockType` is `local` or `warehouse`
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .productName
      </td>

      <td>
        string
      </td>

      <td>
        Yes
      </td>

      <td>
        Product name
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .ProductSku
      </td>

      <td>
        string
      </td>

      <td>
        No
      </td>

      <td>
        Stock Keeping Unit — a unique internal code used to track the product in inventory. Required when `stockType` is `local` or `warehouse`
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .unitPrice
      </td>

      <td>
        double
      </td>

      <td>
        Yes
      </td>

      <td>
        Unit price
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[].quantity
      </td>

      <td>
        int32
      </td>

      <td>
        Yes
      </td>

      <td>
        Quantity ordered
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .length
      </td>

      <td>
        double
      </td>

      <td>
        No
      </td>

      <td>
        Product length
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .width
      </td>

      <td>
        double
      </td>

      <td>
        No
      </td>

      <td>
        Product width
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .height
      </td>

      <td>
        double
      </td>

      <td>
        No
      </td>

      <td>
        Product height
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .weight
      </td>

      <td>
        double
      </td>

      <td>
        No
      </td>

      <td>
        Product weight
      </td>
    </tr>

    <tr>
      <td>
        orderedProducts[]
        .stockType
      </td>

      <td>
        string
      </td>

      <td>
        Yes
      </td>

      <td>
        Stock type — products must be either all `warehouse`, or a mix of `local` and `none`
      </td>
    </tr>

    <tr>
      <td>
        **deliveryType**
      </td>

      <td>
        string
      </td>

      <td>
        Yes
      </td>

      <td>
        Delivery type — allowed values: `pickup-point`, `home`, `return`
      </td>
    </tr>

    <tr>
      <td>
        **description**
      </td>

      <td>
        string
      </td>

      <td>
        Yes
      </td>

      <td>
        Description — must be between 2 and 250 characters
      </td>
    </tr>

    <tr>
      <td>
        **stateId**
      </td>

      <td>
        uuid
      </td>

      <td>
        No
      </td>

      <td>
        State identifier — if provided, it will be considered - Possible values <Anchor label="Workflow" target="_blank" href="https://docs.zrexpress.app/reference/searchworkflowsendpoint">Workflow</Anchor>
      </td>
    </tr>

    <tr>
      <td>
        **amount**
      </td>

      <td>
        double
      </td>

      <td>
        Yes
      </td>

      <td>
        Amount ≤ 150,000 DZD (including delivery fee)
      </td>
    </tr>

    <tr>
      <td>
        **weight**
      </td>

      <td>
        object
      </td>

      <td>
        No
      </td>

      <td>
        Weight details
      </td>
    </tr>

    <tr>
      <td>
        weight.weight
      </td>

      <td>
        double
      </td>

      <td>
        Yes
      </td>

      <td>
        Actual weight
      </td>
    </tr>

    <tr>
      <td>
        weight
        .dimensionalWeight
      </td>

      <td>
        double
      </td>

      <td>
        No
      </td>

      <td>
        Dimensional weight
      </td>
    </tr>

    <tr>
      <td>
        **ExternalId**
      </td>

      <td>
        string
      </td>

      <td>
        No
      </td>

      <td>
        Unique reference ID for this parcel. Max 100 characters. Must be unique across all parcels
      </td>
    </tr>

    <tr>
      <td>
        **HubStockId**
      </td>

      <td>
        Guid
      </td>

      <td>
        No
      </td>

      <td>
        Unique identifier of the hub where the items are stored
      </td>
    </tr>
  </tbody>
</Table>

<br />

<Callout icon="⚠️" theme="warn">
  #### **Important notes:**

If the `stateId` is **not provided** in the request, the order will be created with the status **`OrderReceived`** by default.\
In this case, the order must later be updated to **`ReadyToDispatch`** for the hub to accept it.

If you want the order to be **created directly as ready to dispatch**, you must explicitly provide the `stateId` corresponding to **`ReadyToDispatch`** in the request.

***

\*When creating a parcel, it is not mandatory to link it to an existing customer.\
If you do not want to associate the parcel with a registered customer, you may provide **any valid (random) GUID** in the `customerId` field. </Callout>

***

> ## Request Example

```curl
curl --request POST \
     --url https://api.zrexpress.app/api/v{version}/parcels \
     --header 'accept: application/json' \
     --header 'X-Tenant: YOUR-TENANT-ID' \
     --header 'content-type: application/json' \
     --header 'X-Api-Key: YOUR-API-KEY'
     --data '{
  "customer": {
    "customerId": "5c809fd6-dfca-4f72-a88a-10dd333339de",
    "name": "Mohamed Amine",
    "phone": {
      "number1": "+213550050505",
      "number2": "+213666060606"
    }
  },
  "deliveryAddress": {
    "street": "cité 221 lots, num 98 ",
    "city": "Tlemcen",
    "district": "Bab El Assa",
    "postalCode": "13025",
    "country": "algeria",
    "cityTerritoryId": "53c9e062-9c4e-4c77-8b71-55eabf887f83",
    "districtTerritoryId": "8d0b6cd9-7712-47d2-9ea4-460246494c32"
  },
  "orderedProducts": [
    {
      "unitPrice": 1000,
      "quantity": 5,
      "productId": "80d318ff-55f2-445e-a3e5-3ad40be223c4",
      "productName": "Chocolat au lait Lindt",
      "length": 20,
      "width": 10,
      "height": 1,
      "weight": 1,
      "stockType": "local"
    }
  ],
  "amount": 5000,
  "description": "Chocolat au lait Lindt",
  "deliveryType": "home"
}'
```

> ## Response
>
> If the parcel is successfully created, you will receive a `201 Created` response containing the parcel ID.

**Status`201 Created` Response Body**

| Name | Type | Description                                    |
| ---- | ---- | ---------------------------------------------- |
| id   | uuid | The unique identifier of the created resource. |

> If validation of any input fails, the API will return a `400 Bad Request` error with details about the failed validations.

**Status`400 Bad Request` Response Body Example**

```json
{
  "type": "https://tools.ietf.org/html/rfc7231#section-6.5.1",
  "title": "General.Validation",
  "status": 400,
  "detail": "One or more validation errors occurred",
  "errors": [
    {
      "code": "GreaterThanValidator",
      "description": "DeliveryType must be either 'home' or 'pickup-point'.",
      "type": 2
    },
    {
      "code": "GreaterThanValidator",
      "description": "Products must be either all Warehouse, or a mix of Local and None.",
      "type": 2
    }
  ],
  "traceId": "00-a0ffff7dcd26883866e64624673922a5-4247823a32b02a58-01"
}
```

> If any requested resource (e.g., supplier, hub, deliveryPrice...) does not exist, the API will return a 404 Not Found error.

```json
{
  "type": "https://tools.ietf.org/html/rfc7231#section-6.5.4",
  "title": "Parcels.NotFound",
  "status": 404,
  "detail": "The supplier with the identifier 2e2edec1-1be7-46c9-b403-ae66ee4f1b11 was not found",
  "traceId": "00-f93e5d4c017ac576574389cedc66987b-215e10275393014f-01"
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
    "/api/v{version}/parcels": {
      "post": {
        "tags": [
          "orders"
        ],
        "summary": "Creates a parcel",
        "description": "Creates a parcel with products. The `StockType` parameter indicates the type of stock and accepts 'local' or 'warehouse'. Defaults to 'local' if not specified. the 'DeliveryType' parameter indicates the type of delivery and accepts 'home' or 'pickup-point'. Permissions requises : SupplierAdminRole, SupplierParcelsManagerRole.",
        "operationId": "CreateParcelEndpoint",
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
                "$ref": "#/components/schemas/CreateParcelRequest"
              }
            }
          },
          "required": true
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CreateParcelResponse"
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
      "CreateParcelRequest": {
        "type": "object",
        "properties": {
          "customer": {
            "$ref": "#/components/schemas/ParcelCustomerDto"
          },
          "deliveryAddress": {
            "$ref": "#/components/schemas/DeliveryAddressInputDto"
          },
          "hubId": {
            "type": "string",
            "format": "uuid",
            "nullable": true
          },
          "orderedProducts": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/OrderedProductDto"
            },
            "nullable": true
          },
          "deliveryType": {
            "type": "string",
            "nullable": true
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "stateId": {
            "type": "string",
            "format": "uuid",
            "nullable": true
          },
          "amount": {
            "type": "number",
            "format": "double"
          },
          "weight": {
            "$ref": "#/components/schemas/ParcelWeightDto"
          },
          "externalId": {
            "type": "string",
            "nullable": true
          },
          "hubStockId": {
            "type": "string",
            "format": "uuid",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "CreateParcelResponse": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          }
        },
        "additionalProperties": false
      },
      "DeliveryAddressInputDto": {
        "type": "object",
        "properties": {
          "cityTerritoryId": {
            "type": "string",
            "format": "uuid"
          },
          "districtTerritoryId": {
            "type": "string",
            "format": "uuid"
          },
          "street": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "OrderedProductDto": {
        "type": "object",
        "properties": {
          "productId": {
            "type": "string",
            "format": "uuid"
          },
          "productName": {
            "type": "string",
            "nullable": true
          },
          "productSku": {
            "type": "string",
            "nullable": true
          },
          "unitPrice": {
            "type": "number",
            "format": "double"
          },
          "quantity": {
            "type": "integer",
            "format": "int32"
          },
          "length": {
            "type": "number",
            "format": "double"
          },
          "width": {
            "type": "number",
            "format": "double"
          },
          "height": {
            "type": "number",
            "format": "double"
          },
          "weight": {
            "type": "number",
            "format": "double",
            "nullable": true
          },
          "stockType": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "ParcelCustomerDto": {
        "type": "object",
        "properties": {
          "customerId": {
            "type": "string",
            "format": "uuid"
          },
          "name": {
            "type": "string",
            "nullable": true
          },
          "phone": {
            "$ref": "#/components/schemas/PhoneDto"
          }
        },
        "additionalProperties": false
      },
      "ParcelWeightDto": {
        "type": "object",
        "properties": {
          "weight": {
            "type": "number",
            "format": "double"
          },
          "dimensionalWeight": {
            "type": "number",
            "format": "double",
            "nullable": true
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