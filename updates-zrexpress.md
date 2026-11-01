---
updatedAt: 2026-01-14T21:11:49.000Z
---

Fetch the complete documentation index at: https://docs.zrexpress.app/llms.txt. Use this file to discover all available pages before exploring further.

# gets parcel state history

gets parcel state history. Permissions requises : SupplierAdminRole, SupplierParcelsManagerRole.

***

**Permissions required:**  `SupplierAdminRole`, `SupplierParcelsManagerRole`.

***

> ## Path Parameters

| Name     | Type   | Required | Description                              |
| :------- | :----- | :------- | :--------------------------------------- |
| version  | string | Yes      | The requested API version (default: `1`) |
| parcelId | uuid   | yes      | The ID of the parcel.                    |

> ## Headers

| Name      | Type   | Required | Description                                                                                                                      |
| :-------- | :----- | :------- | :------------------------------------------------------------------------------------------------------------------------------- |
| X-Tenant  | string | Yes      | Tenant ID required to access this API.                                                                                           |
| X-Api-Key | string | Yes      | API key required for authentication. To see how to get it, check this [guide](https://docs.zrexpress.app/docs/authentication#/). |

## Response

**Status 200 OK**

<Table align={["left","left","left"]}>
  <thead>
    <tr>
      <th>
        Field
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
        `id`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Unique identifier of the parcel state history entry.
      </td>
    </tr>

    <tr>
      <td>
        `parcelId`
      </td>

      <td>
        `Guid`
      </td>

      <td>
        Identifier of the parcel related to this state history entry.
      </td>
    </tr>

    <tr>
      <td>
        `createdAt`
      </td>

      <td>
        `date-time`
      </td>

      <td>
        Timestamp when the state transition occurred.
      </td>
    </tr>

    <tr>
      <td>
        `previousState`
      </td>

      <td>
        `object`
      </td>

      <td>
        Parcel state before the transition (optional).
      </td>
    </tr>

    <tr>
      <td>
        `previousState.id`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Identifier of the previous state.
      </td>
    </tr>

    <tr>
      <td>
        `previousState.name`
      </td>

      <td>
        `string`
      </td>

      <td>
        Name of the previous state.
      </td>
    </tr>

    <tr>
      <td>
        `previousState  
                                .description`
      </td>

      <td>
        `string`
      </td>

      <td>
        Description of the previous state.
      </td>
    </tr>

    <tr>
      <td>
        `previousState  
                                .isBlocking`
      </td>

      <td>
        `boolean`
      </td>

      <td>
        Indicates whether the state blocks workflow actions.
      </td>
    </tr>

    <tr>
      <td>
        `previousState  
                                .isLocked`
      </td>

      <td>
        `boolean`
      </td>

      <td>
        Indicates whether the parcel is locked in this state.
      </td>
    </tr>

    <tr>
      <td>
        `previousState  
                                .visibleFor`
      </td>

      <td>
        `object`
      </td>

      <td>
        Actors allowed to view this state.
      </td>
    </tr>

    <tr>
      <td>
        `previousState  
                                .editableBy`
      </td>

      <td>
        `object`
      </td>

      <td>
        Actors allowed to edit in this state.
      </td>
    </tr>

    <tr>
      <td>
        `previousState  
                                .color`
      </td>

      <td>
        `string`
      </td>

      <td>
        UI color associated with the state.
      </td>
    </tr>

    <tr>
      <td>
        `newState`
      </td>

      <td>
        `object`
      </td>

      <td>
        Parcel state after the transition.
      </td>
    </tr>

    <tr>
      <td>
        `newState.id`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Identifier of the new state.
      </td>
    </tr>

    <tr>
      <td>
        `newState.name`
      </td>

      <td>
        `string`
      </td>

      <td>
        Name of the new state.
      </td>
    </tr>

    <tr>
      <td>
        `newState  
                                .description`
      </td>

      <td>
        `string`
      </td>

      <td>
        Description of the new state.
      </td>
    </tr>

    <tr>
      <td>
        `newState  
                                .isBlocking`
      </td>

      <td>
        `boolean`
      </td>

      <td>
        Indicates whether the state blocks workflow actions.
      </td>
    </tr>

    <tr>
      <td>
        `newState  
                                .isLocked`
      </td>

      <td>
        `boolean`
      </td>

      <td>
        Indicates whether the parcel is locked in this state.
      </td>
    </tr>

    <tr>
      <td>
        `newState  
                                .visibleFor`
      </td>

      <td>
        `flag`
      </td>

      <td>
        Who can see this state
      </td>
    </tr>

    <tr>
      <td>
        `newState  
                                .editableBy`
      </td>

      <td>
        `flag`
      </td>

      <td>
        Actors allowed to edit in this state.
      </td>
    </tr>

    <tr>
      <td>
        `newState.color`
      </td>

      <td>
        `string`
      </td>

      <td>
        UI color associated with the state.
      </td>
    </tr>

    <tr>
      <td>
        `modifiedBy`
      </td>

      <td>
        `object`
      </td>

      <td>
        User who performed the state change.
      </td>
    </tr>

    <tr>
      <td>
        `modifiedBy.id`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Identifier of the user.
      </td>
    </tr>

    <tr>
      <td>
        `modifiedBy  
                                .fullName`
      </td>

      <td>
        `string`
      </td>

      <td>
        Full name of the user.
      </td>
    </tr>

    <tr>
      <td>
        `location`
      </td>

      <td>
        `object`
      </td>

      <td>
        Location context where the state change occurred.
      </td>
    </tr>

    <tr>
      <td>
        `location.hubId`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Identifier of the hub.
      </td>
    </tr>

    <tr>
      <td>
        `location  
                                .hubName`
      </td>

      <td>
        `string`
      </td>

      <td>
        Name of the hub.
      </td>
    </tr>

    <tr>
      <td>
        `location  
                                .hubCity`
      </td>

      <td>
        `string`
      </td>

      <td>
        City of the hub.
      </td>
    </tr>

    <tr>
      <td>
        `location  
                                .hubDistrict`
      </td>

      <td>
        `string`
      </td>

      <td>
        District of the hub.
      </td>
    </tr>

    <tr>
      <td>
        `location.type`
      </td>

      <td>
        `string`
      </td>

      <td>
        Location type
      </td>
    </tr>

    <tr>
      <td>
        `location  
                                .membership`
      </td>

      <td>
        `string`
      </td>

      <td>
        Membership.
      </td>
    </tr>

    <tr>
      <td>
        `location  
                                .hubTerritoryCityId`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Territory city identifier.
      </td>
    </tr>

    <tr>
      <td>
        `arrivalHub`
      </td>

      <td>
        `object`
      </td>

      <td>
        Arrival hub related to the transition.
      </td>
    </tr>

    <tr>
      <td>
        `comment`
      </td>

      <td>
        `string`
      </td>

      <td>
        Optional comment explaining the state change.
      </td>
    </tr>

    <tr>
      <td>
        `situations`
      </td>

      <td>
        `array`
      </td>

      <td>
        Situations or exceptions associated with this transition.
      </td>
    </tr>

    <tr>
      <td>
        `situations[].id`
      </td>

      <td>
        `uuid`
      </td>

      <td>
        Identifier of the situation entry.
      </td>
    </tr>

    <tr>
      <td>
        `situations[]  
                                .createdAt`
      </td>

      <td>
        `date-time`
      </td>

      <td>
        Timestamp of the situation entry.
      </td>
    </tr>

    <tr>
      <td>
        `situations[]  
                                .comment`
      </td>

      <td>
        `string`
      </td>

      <td>
        Situation comment (optional).
      </td>
    </tr>
  </tbody>
</Table>

> #### Notes
>
> Optional fields are omitted from JSON responses when their value is `null` .

***

> ## Example request

```curl
curl -X 'GET' \
'https://api.zrexpress.app/api/v1.0/parcels/83d1541f-ed41-4a6a-b395-b2bca36bd531/state-history' \
  -H 'accept: application/json' \
  -H 'X-Tenant: YOUR-TENANT-ID' \
	-H 'X-Api-Key: YOUR-API-KEY'
```

> ## Example Response

```json
[
    {
        "id": "b6762c5e-00fe-457b-2e1b-08de423748c6",
        "createdAt": "2025-12-23T15:23:54.2173951+00:00",
        "newState": {
            "id": "8ce66a55-5001-436a-97ec-86daecffcca8",
            "name": "commande_recue",
            "description": "Commande reçue",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 1,
            "editableBy": 3,
            "color": "1e88e5"
        },
        "modifiedBy": {
            "id": "7615e7ef-34d2-4da3-9706-5a67d72096e5",
            "fullName": "Four8 Tlemcen8"
        },
        "situations": []
    },
    {
        "id": "f940228b-3687-4c43-efc1-08de42376792",
        "createdAt": "2025-12-23T15:24:50.0209172+00:00",
        "previousState": {
            "id": "8ce66a55-5001-436a-97ec-86daecffcca8",
            "name": "commande_recue",
            "description": "Commande reçue",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 1,
            "editableBy": 3,
            "color": "1e88e5"
        },
        "newState": {
            "id": "8a948c66-1ab7-4433-aeb0-94219125d134",
            "name": "pret_a_expedier",
            "description": "Prêt à expédier",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 3,
            "editableBy": 3,
            "color": "0288d1"
        },
        "modifiedBy": {
            "id": "7615e7ef-34d2-4da3-9706-5a67d72096e5",
            "fullName": "Four8 Tlemcen8"
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "671a0f40-73a4-4920-9713-08de42290add",
        "createdAt": "2025-12-23T15:29:14.352759+00:00",
        "previousState": {
            "id": "8a948c66-1ab7-4433-aeb0-94219125d134",
            "name": "pret_a_expedier",
            "description": "Prêt à expédier",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 3,
            "editableBy": 3,
            "color": "0288d1"
        },
        "newState": {
            "id": "abe82977-bc6b-4c89-9553-d2ced1e635dd",
            "name": "confirme_au_bureau",
            "description": "Confirmé au bureau",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "6a1b9a"
        },
        "modifiedBy": {
            "id": "2453f099-ccfe-4569-a06f-ea6e641ef90a",
            "fullName": "Bureau Tlemcen"
        },
        "location": {
            "hubId": "186e3be6-c250-49d3-b432-363a85a7d028",
            "hubName": "Bureau Tlemcen",
            "hubCity": "Tlemcen",
            "hubDistrict": "Tlemcen",
            "type": "hub",
            "membership": null,
            "hubTerritoryCityId": "53c9e062-9c4e-4c77-8b71-55eabf887f83"
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "cf3f9fd7-3348-434a-99c5-08de42290add",
        "createdAt": "2025-12-23T15:34:05.7191354+00:00",
        "previousState": {
            "id": "abe82977-bc6b-4c89-9553-d2ced1e635dd",
            "name": "confirme_au_bureau",
            "description": "Confirmé au bureau",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "6a1b9a"
        },
        "newState": {
            "id": "66ebba7f-026c-46a9-8c9a-beef756cb84b",
            "name": "vers_wilaya",
            "description": "Dispatch dans une autre wilaya",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "d32f2f"
        },
        "modifiedBy": {
            "id": "72b32eec-0673-42bc-b857-56f45fef1006",
            "fullName": "CLA Driver1"
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "8c648495-fba6-47fd-9b87-08de42290add",
        "createdAt": "2025-12-23T15:52:12.2303613+00:00",
        "previousState": {
            "id": "66ebba7f-026c-46a9-8c9a-beef756cb84b",
            "name": "vers_wilaya",
            "description": "Dispatch dans une autre wilaya",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "d32f2f"
        },
        "newState": {
            "id": "abe82977-bc6b-4c89-9553-d2ced1e635dd",
            "name": "confirme_au_bureau",
            "description": "Confirmé au bureau",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "6a1b9a"
        },
        "modifiedBy": {
            "id": "f237c5a7-fbba-407e-9811-e0633f7fdb7d",
            "fullName": "Manager Khroub"
        },
        "location": {
            "hubId": "ce52ae12-7d21-48fc-8640-0b2342a7cce2",
            "hubName": "Bureau khroub",
            "hubCity": "Constantine",
            "hubDistrict": "El Khroub",
            "type": "stopdesk",
            "membership": null,
            "hubTerritoryCityId": "e9a1e9cf-8475-4768-94cc-0888d094ff47"
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "d3a129dd-1211-4458-6519-08de42f58453",
        "createdAt": "2025-12-25T09:28:14.6970501+00:00",
        "previousState": {
            "id": "abe82977-bc6b-4c89-9553-d2ced1e635dd",
            "name": "confirme_au_bureau",
            "description": "Confirmé au bureau",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "6a1b9a"
        },
        "newState": {
            "id": "22335295-79af-458b-8663-beea6b3ac5e2",
            "name": "en_livraison",
            "description": "En livraison",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 15,
            "editableBy": 2,
            "color": "ff6f00"
        },
        "modifiedBy": {
            "id": "f237c5a7-fbba-407e-9811-e0633f7fdb7d",
            "fullName": "Manager Khroub"
        },
        "location": {
            "hubId": "ce52ae12-7d21-48fc-8640-0b2342a7cce2",
            "hubName": "Bureau khroub",
            "hubCity": "Constantine",
            "hubDistrict": "El Khroub",
            "type": "stopdesk",
            "membership": null,
            "hubTerritoryCityId": "e9a1e9cf-8475-4768-94cc-0888d094ff47"
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "6e7b5adb-a111-4de6-0c0e-08de478d85ee",
        "createdAt": "2025-12-30T13:24:34.4697455+00:00",
        "previousState": {
            "id": "22335295-79af-458b-8663-beea6b3ac5e2",
            "name": "en_livraison",
            "description": "En livraison",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 15,
            "editableBy": 2,
            "color": "ff6f00"
        },
        "newState": {
            "id": "95bc5a68-03f4-497d-8c96-81c4d0ff14ae",
            "name": "sortie_en_livraison",
            "description": "Sortie en livraison",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 15,
            "editableBy": 2,
            "color": "ff6f00"
        },
        "modifiedBy": {
            "id": "f237c5a7-fbba-407e-9811-e0633f7fdb7d",
            "fullName": "Manager Khroub"
        },
        "location": {
            "hubId": "ce52ae12-7d21-48fc-8640-0b2342a7cce2",
            "hubName": "Bureau khroub",
            "hubCity": "Constantine",
            "hubDistrict": "El Khroub",
            "type": "stopdesk",
            "membership": null,
            "hubTerritoryCityId": "e9a1e9cf-8475-4768-94cc-0888d094ff47"
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "19bd9c0c-bfac-43be-0c23-08de478d85ee",
        "createdAt": "2025-12-30T13:35:27.4275354+00:00",
        "previousState": {
            "id": "95bc5a68-03f4-497d-8c96-81c4d0ff14ae",
            "name": "sortie_en_livraison",
            "description": "Sortie en livraison",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 15,
            "editableBy": 2,
            "color": "ff6f00"
        },
        "newState": {
            "id": "8359ea70-5d8d-4f87-b4cb-7333fdb083bd",
            "name": "livre",
            "description": "Livré",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 15,
            "editableBy": 6,
            "color": "388e3c"
        },
        "modifiedBy": {
            "id": "aa967629-b240-4a0b-a630-92f9bb42f39d",
            "fullName": "test lab"
        },
        "location": {
            "hubId": "ce52ae12-7d21-48fc-8640-0b2342a7cce2",
            "hubName": "Bureau khroub",
            "hubCity": "Constantine",
            "hubDistrict": "El Khroub",
            "type": "stopdesk",
            "membership": "delivery-person",
            "hubTerritoryCityId": null
        },
        "comment": "",
        "situations": []
    },
    {
        "id": "7944f1b0-ae8e-4f2a-0c58-08de478d85ee",
        "createdAt": "2025-12-30T14:43:33.7809351+00:00",
        "previousState": {
            "id": "8359ea70-5d8d-4f87-b4cb-7333fdb083bd",
            "name": "livre",
            "description": "Livré",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 15,
            "editableBy": 6,
            "color": "388e3c"
        },
        "newState": {
            "id": "f34dfc2c-ecfe-4e06-9a19-430d2d0b27b9",
            "name": "encaisse",
            "description": "Encaissé",
            "isBlocking": false,
            "isLocked": false,
            "visibleFor": 7,
            "editableBy": 2,
            "color": "00796b"
        },
        "modifiedBy": {
            "id": "f237c5a7-fbba-407e-9811-e0633f7fdb7d",
            "fullName": "Manager Khroub"
        },
        "situations": []
    }
]
```

***

## ZRexpress Workflow States and Situations explanation

***

This section provides a detailed explanation of the delivery workflow states, their associated situations (sub-states), and the roles responsible for each transition.

***

The system uses a bitmask to define access:

* **Supplier (1)**: The merchant/client.
* **ProDelivery (2)**: Admin, Hub Agents, and Backoffice.
* **Delivery Person (4)**: Drivers and Couriers.
* **Customer (8)**: Recipient (Tracking view).

***

### 1. Core Workflow States

| State Slug            | Name (FR)               | Responsibility  | Description                                                        |
| :-------------------- | :---------------------- | :-------------- | :----------------------------------------------------------------- |
| `commande_recue`      | Commande reçue          | **Supplier**    | Initial creation of the parcel.                                    |
| `en_traitement`       | En traitement           | **Admin**       | Acknowledged by the system, awaiting validation.                   |
| `appel_confirmation`  | Appel de confirmation   | **Call Center** | Active phase where agents call the customer to confirm details.    |
| `commande_confirmee`  | Commande confirmée      | **Call Center** | Order details validated with the customer.                         |
| `en_preparation`      | En préparation          | **Supplier**    | Merchant is packing the items for the driver.                      |
| `pret_a_expedier`     | Prêt à expédier         | **Supplier**    | Marking the parcel as ready for pickup from the supplier location. |
| `confirme_au_bureau`  | Confirmé au bureau      | **Hub Agent**   | Parcel arrived at a ProDelivery Hub or StopDesk.                   |
| `dispatch`            | Dispatch (Local)        | **Logistics**   | Sorting for delivery within the same city/wilaya.                  |
| `vers_wilaya`         | Dispatch (Inter-wilaya) | **Logistics**   | Transporting to another province hub.                              |
| `en_livraison`        | En livraison            | **Admin**       | Assigned to a specific delivery person's bag/tour.                 |
| `sortie_en_livraison` | Sortie en livraison     | **Driver**      | Driver is currently on the road with the parcel.                   |
| `livre`               | Livré                   | **Driver**      | Handed over to the customer and payment received (if COD).         |
| `encaisse`            | Encaissé                | **Finance**     | Payment validated and deposited at the hub.                        |
| `recouvert`           | Recouvert               | **Finance**     | Funds cleared for supplier payout.                                 |

***

### 2. State Situations (Reasons & Context)

Situations provide specific reasons why a parcel moved to a state or why it is blocked.

#### A. Confirmation Phase (`appel_confirmation`)

Managed by the **Call Center/Admin**:

* **Ne répond pas (1, 2, 3)**: Logs successive failed call attempts.
* **Injoignable**: Customer's phone signal is failing.
* **Commande annulée**: Customer cancelled during the confirmation call.

#### B. Delivery Phase (`sortie_en_livraison`)

Managed by the **Delivery Person (Driver)**:

* **Appel téléphonique** : Calls made by the delivery person to the customer are automatically logged by the system for each attempt.
* **Ne répond pas (1, 2, 3)**: Delivery person tried to reach the customer at the address.
* **Commune erronée**: Address error; requires selecting a new territory/district.
* **Reporté**: Customer postponed the delivery to a specific date.
* **Changement bureau**: Parcel redirected from home delivery to a StopDesk.
* **Commande annulée**: Refused at the door.

#### C. StopDesk Phase (`confirme_au_bureau`)

Managed by the **StopDesk Agent**:

* **En attente du client**: Ready for pickup at the counter.
* **SMS envoyé**: Notification sent to the recipient.

***

### 3. Special Management States

* **En attente d'échange**: Used when a new parcel is sent only after receiving an old one.
* **Remboursement réinjecté**: Handling of partial or full refunds returned to stock.
* **Réinjecté dans le stock**: Parcel items have been returned to inventory.

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
    "/api/v{version}/parcels/{parcelId}/state-history": {
      "get": {
        "tags": [
          "orders"
        ],
        "summary": "gets parcel state history",
        "description": "gets parcel state history. Permissions requises : SupplierAdminRole, SupplierParcelsManagerRole.",
        "operationId": "GetParcelStateHistorySupplierEndpoint",
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
            "name": "parcelId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
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
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/ParcelStateHistoryDto"
                  }
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
      "ActorVisibilities": {
        "enum": [
          0,
          1,
          2,
          4,
          8
        ],
        "type": "integer",
        "format": "int32"
      },
      "HubSnapshot": {
        "type": "object",
        "properties": {
          "hubId": {
            "type": "string",
            "format": "uuid",
            "nullable": true,
            "readOnly": true
          },
          "hubName": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "hubCity": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "hubCityTerritoryId": {
            "type": "string",
            "format": "uuid",
            "nullable": true,
            "readOnly": true
          },
          "hubDistrict": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "hubDistrictTerritoryId": {
            "type": "string",
            "format": "uuid",
            "nullable": true,
            "readOnly": true
          },
          "hubType": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          }
        },
        "additionalProperties": false
      },
      "LocationSnapshot": {
        "type": "object",
        "properties": {
          "hubId": {
            "type": "string",
            "format": "uuid",
            "nullable": true,
            "readOnly": true
          },
          "hubName": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "hubCity": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "hubDistrict": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "type": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "membership": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "hubTerritoryCityId": {
            "type": "string",
            "format": "uuid",
            "nullable": true,
            "readOnly": true
          }
        },
        "additionalProperties": false
      },
      "ParcelStateHistoryDto": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "previousState": {
            "$ref": "#/components/schemas/StateDto"
          },
          "newState": {
            "$ref": "#/components/schemas/StateDto"
          },
          "modifiedBy": {
            "$ref": "#/components/schemas/UserSnapshot"
          },
          "location": {
            "$ref": "#/components/schemas/LocationSnapshot"
          },
          "arrivalHub": {
            "$ref": "#/components/schemas/HubSnapshot"
          },
          "comment": {
            "type": "string",
            "nullable": true
          },
          "situations": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/ParcelStateSituationHistoryDto"
            },
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "ParcelStateSituationHistoryDto": {
        "type": "object",
        "properties": {
          "situationName": {
            "type": "string",
            "nullable": true
          },
          "situationSlug": {
            "type": "string",
            "nullable": true
          },
          "situationDescription": {
            "type": "string",
            "nullable": true
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "modifiedBy": {
            "$ref": "#/components/schemas/UserSnapshot"
          },
          "metadata": {
            "type": "object",
            "additionalProperties": {},
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "StateDto": {
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
          "description": {
            "type": "string",
            "nullable": true
          },
          "isBlocking": {
            "type": "boolean",
            "nullable": true
          },
          "isLocked": {
            "type": "boolean",
            "nullable": true
          },
          "visibleFor": {
            "$ref": "#/components/schemas/ActorVisibilities"
          },
          "editableBy": {
            "$ref": "#/components/schemas/ActorVisibilities"
          },
          "color": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "UserSnapshot": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid",
            "readOnly": true
          },
          "fullName": {
            "type": "string",
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