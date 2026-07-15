2026-05-06 

## - API Documentation NOEST Public API 

## 🚀 General Information 

Property Value Base URL `https://app.noest-dz.com` Format JSON 

Authentication Bearer Token (api_token) 

## Authentication 

All endpoints require authentication via: 

Header: `Authorization: Bearer {api_token}` 

Parameter: `user_guid` (Partner GUID provided by NOEST) 

The `api_token` and `user_guid` credentials are provided by NOEST when your account is created. 

## 📦 Order Management 

## 1. Create an Order 

Create a single order. 

## Endpoint 

```
POST /api/public/create/order
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`user_guid`|string|Yes|PartnerGUIDprovided byNOEST|
|`reference`|string|No|Order reference (min: 5 characters)|
|`client`|string|Yes|Customer full name (max: 255 characters)|



1 / 29 

2026-05-06 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`phone`|string|Yes|Phone number (9-10 digits)|
|`phone_2`|string|No|Secondary phone number (9-10 digits)|
|`adresse`|string|Yes|Delivery address (max: 255 characters)|
|`wilaya_id`|integer|Conditional|WilayaID(1-58).Required if `zip_code` is not<br>provided|
|`commune`|string|Conditional|Commune name.Required if `zip_code` and<br>`stop_desk` are not provided|
|`montant`|numeric|Yes|Order amount|
|`remarque`|string|No|Remarks (max: 255 characters)|
|`produit`|string|Yes|Product name/reference,Multiple products<br>separated by comma|
|`type_id`|integer|Yes|Delivery type: 1=Delivery, 2=Exchange, 3=Pick-up|
|`poids`|numeric|No|Package weight (according to partner limit)|
|`stop_desk`|integer|Yes|Delivery to relay point: 0=Home, 1=Stop desk|
|`station_expedition`|integer|No|Expedition stationCode (feature must be enabled<br>on your account)|
|`station_code`|string|Conditional|Station code.Required if `stop_desk=1`|
|`stock`|integer|No|Order with stock: 0=No, 1=Yes|
|`quantite`|string|Conditional|Quantities separated by comma.Required if<br>`stock=1`|
|`can_open`|integer|No|Opening authorization: 0=No, 1=Yes|
|`shop_name`|string|No|Shop name (max: 255 characters)|
|`zip_code`|string|No|Postal code (replaces `wilaya_id` and `commune`)|
|`remboursement`|integer|No|Reimbursement type: 0=No, 1=Yes (amount < 0:<br>refund, amount > 0: collection)|



## Request Example 

```
{
  "user_guid": "abc123-def456-ghi789",
  "reference": "REF12345",
  "client": "Ahmed Ahmed",
  "phone": "0550505050",
  "phone_2": "0660606060",
  "adresse": "Rue des Martyrs, Bab Ezzouar",
  "wilaya_id": 16,
```

2 / 29 

2026-05-06 

```
  "commune": "Bab Ezzouar",
  "montant": 3500,
  "produit": "Smartphone Samsung Galaxy",
  "type_id": 1,
  "poids": 0.5,
  "stop_desk": 0,
  "remarque": "Call before delivery",
  "can_open": 1
}
```

## Success Response 

```
{
  "success": true,
  "tracking": "ECS1234567890",
  "reference": "REF001",
  "regional_hub_name": "W",
  "wilaya_rank": "16B"
}
```

## Common Error Messages 

|Error|Description|
|---|---|
|`account_suspended`|Partner account suspended|
|`commune inexistante ou non activée`|The specified commune does not exist in the|
||database|
|`zip_code invalide`|Invalid postal code|
|`Le code de wilaya est different de code`<br>`de station`|Mismatch between wilaya and station code|
|`Aucune commune liee a la station choisie`|No commune associated with the station|
|`Il faut choisir un code de station valide`|Invalid station code|
|`Module stopdesk désactivé pour cette`<br>`wilaya`|Stop desk not available for this wilaya|
|`montant doit être inferieur à X`|Amount exceeds the allowed limit|



## 2. Create Bulk Orders 

Create multiple orders in a single request. 

## Endpoint 

3 / 29 

2026-05-06 

```
POST /api/public/create/orders
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`user_guid`|string|Yes|PartnerGUID|
|`orders`|array|Yes|Array of orders (min: 1, max: 100)|



## Order Structure 

See the same parameters as single order creation. 

## Request Example 

```
{
  "user_guid": "abc123-def456-ghi789",
  "orders": [
    {
      "reference": "REF001",
      "client": "Ahmed Ahmed",
      "phone": "0550000000",
      "adresse": "Rue des Martyrs, Bab Ezzouar",
      "wilaya_id": 16,
      "commune": "Bab Ezzouar",
      "montant": 3500,
      "produit": "Smartphone Samsung",
      "type_id": 1,
      "stop_desk": 0,
      "poids": 0.5
    },
    {
      "reference": "REF002",
      "client": "Fatima Fatima",
      "phone": "0770000000",
      "adresse": "Cité 300 logements",
      "zip_code": "16000",
      "montant": 2000,
      "produit": "Bluetooth Earphones",
      "type_id": 1,
      "stop_desk": 0
```

4 / 29 

2026-05-06 

```
    }
  ]
}
```

## Success Response 

```
{
  "success": true,
  "passed": {
    "0": {
      "success": true,
      "tracking": "TRK123456789"
    },
    "1": {
      "success": true,
      "tracking": "TRK987654321"
    }
  },
  "failed": {}
}
```

## Response with Errors 

```
{
  "success": false,
  "passed": {
    "0": {
      "success": true,
      "tracking": "TRK123456789"
    }
  },
  "failed": {
    "1": {
      "reference": "Order reference (if sent)",
      "phone": ["The phone field is required."],
      "commune": ["The selected commune is invalid."]
    }
  }
}
```

## Possible Errors Table 

Errors can be classified into two categories: validation errors and custom business errors. 

Validation Errors 

5 / 29 

2026-05-06 

||**Field**<br>**Error**<br>**Description**<br>`user_guid`<br>The user_guid field is required.<br>MissingGUID<br>`user_guid`<br>The selected user_guid is invalid.<br>GUIDdoes not exist<br>`client`<br>The client field is required.<br>Customer name missing<br>`client`<br>The client field may not be greater than<br>255 characters.<br>Name too long<br>`phone`<br>The phone field is required.<br>Phone number missing<br>`phone`<br>The phone field must be between 9 and 10<br>digits.<br>Invalid phone format<br>`phone_2`<br>The phone_2 field must be between 9 and<br>10 digits.<br>Invalid secondary phone format<br>`adresse`<br>The adresse field is required.<br>Address missing<br>`adresse`<br>The adresse field may not be greater than<br>255 characters.<br>Address too long<br>`wilaya_id`<br>The wilaya_id field is required.<br>Wilaya missing (if zip_code absent)<br>`wilaya_id`<br>The wilaya_id field must be an integer.<br>Invalid type<br>`wilaya_id`<br>The wilaya_id field must be between 1 and<br>58.<br>WilayaIDout of range<br>`commune`<br>The commune field is required.<br>Commune missing (if zip_code and<br>stop_desk absent)<br>`commune`<br>The selected commune is invalid.<br>Commune does not exist<br>`montant`<br>The montant field is required.<br>Amount missing<br>`montant`<br>The montant field must be numeric.<br>Invalid amount format<br>`remarque`<br>The remarque field may not be greater<br>than 255 characters.<br>Remarks too long<br>`shop_name`<br>The shop_name field may not be greater<br>than 255 characters.<br>Shop name too long<br>`produit`<br>The produit field is required.<br>Product missing<br>`type_id`<br>The type_id field is required.<br>Order type missing<br>`type_id`<br>The type_id field must be between 1 and 3.<br>Invalid type (must be 1, 2 or 3)<br>`poids`<br>The poids field must be numeric.<br>Invalid weight format<br>`poids`<br>The poids field must be at least 0.<br>Negative weight<br>`poids`<br>The poids field may not be greater than X.<br>Weight exceeds allowed limit|
|---|---|



6 / 29 

2026-05-06 

|Field|Error|Description|
|---|---|---|
|`stop_desk`|The stop_desk field is required.|Stop desk missing|
|`stop_desk`|The stop_desk field must be between 0<br>and 1.|Invalid value (must be 0 or 1)|
|`stock`|The stock field must be between 0 and 1.|Invalid value (must be 0 or 1)|
|`can_open`|The can_open field must be between 0<br>and 1.|Invalid value (must be 0 or 1)|
|`quantite`|The quantite field is required.|Quantities missing (if stock=1)|
|`zip_code`|The selected zip_code is invalid.|Postal code does not exist|
|`paypart_ref`|The paypart_ref field may not be greater<br>than 255 characters.|Payment reference too long|
|`station_code`|The station_code field is required.|Station code missing (if stop_desk=1)|
||The reference field must be at least 5||
|`reference`||Reference too short|
||characters.||
||The remboursement field must be between||
|`remboursement`|0 and 1.|Invalid value (must be 0 or 1)|



Custom Business Errors 

|ErrorCode|Message|HTTP|Description|
|---|---|---|---|
||||Partner account is|
|`account_suspended`|Compte suspendu|422|suspended|
||||An order with this|
|`duplicate_order`|Colis déja existant|200|reference already exists|
||||The specified commune|
|`inactive_commune`|commune inexistante ou non activée|422|does not exist or is not|
||||active|
|`zip_code`|zip_code invalide.|200|The provided postal<br>code is invalid|
||||Amount exceeds|
|`max_amount_exceeded`|montant doit être inferieur à X|422|partner's allowed limit|
|`stopdesk_disabled`|Module stopdesk désactivé pour cette<br>wilaya|422|Stop desk is not<br>available for this wilaya|
|`station_expedition`|La station d'expedition n'est pas valide|200|Invalid expedition<br>station code|
|`station_code`|Le code de wilaya est different de code<br>de station|200|Mismatch between<br>wilaya and station code|



7 / 29 

2026-05-06 

|ErrorCode|Message|HTTP|Description|
|---|---|---|---|
||||No commune is|
||Aucune commune liee a la station|||
|`station_code`|choisie.|200|associated with this|
||||station|
|`station_code`|Il faut choisir un code de station valide.|200|The provided station<br>code is invalid|
||||Stock management|
|`disabled_module`|Module de stockage désactivé|422|module is disabled for|
||||this partner|
|`wrong_quantities`|Le nombre des quantités saisi n'est<br>pas identique au nombre des produits|422|Number of quantities ≠<br>number of products|
|`invalid_product`|Le produit avec la réference X n'existe<br>pas ou désactivé|422|The specified product<br>does not exist or is<br>disabled|
||||Insufficient stock for|
|`out_of_stock`|Stock indisponible|422|requested quantity|
|`already_validated`|Commande déjà validée|422|Order has already been<br>validated|



## 3. Validate an Order 

Validate a created order. After validation, the order becomes visible to logistics and can no longer be modified or deleted. 

## Endpoint 

```
POST /api/public/valid/order
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`user_guid`|string|Yes|PartnerGUID|
|`tracking`|string|Yes|Order tracking code|



8 / 29 

2026-05-06 

## Request Example 

```
{
  "user_guid": "abc123-def456-ghi789",
  "tracking": "TRK123456789"
}
```

## Success Response 

```
{
  "success": true
}
```

## Common Error Messages 

|Error|Description|
|---|---|
|`Commande introuvable`|Order does not exist or does not belong to the partner|
|`Commande déjà validée`|Order has already been validated|
|`Stock insuffisant`|Insufficient stock to validate the order (if `stock=1`)|



## 4. Validate Bulk Orders 

Validate multiple orders in a single request. 

## Endpoint 

```
POST /api/public/valid/orders
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`user_guid`|string|Yes|PartnerGUID|



9 / 29 

2026-05-06 

Parameter Type Required Description 

`trackings` array Yes Array of tracking codes (max: 100) 

## Request Example 

Simple format (array of strings): 

```
{
  "user_guid": "abc123-def456-ghi789",
  "trackings": [
"TRK123456789",
"TRK987654321",
"TRK555666777"
  ]
}
```

## Success Response 

```
{
  "success": true,
  "passed": {
    "TRK123456789": true,
    "TRK987654321": true,
    "TRK555666777": true
  },
  "failed": {}
}
```

## Response with Errors 

```
{
  "success": false,
  "passed": {
    "TRK123456789": true
  },
  "failed": {
    "TRK987654321": {
      "tracking": ["The selected tracking is invalid."]
    },
    "TRK555666777": "Insufficient stock for this order"
  }
}
```

10 / 29 

2026-05-06 

## 5. Update an Order 

Creates an order modification request for an existing order. 

## ⚠ Important: 

`tracking` is required. 

- Allowed changes depend on the current order state. 

- Wilaya cannot be changed through this endpoint. 

## Endpoint 

```
POST /api/public/update/order
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`tracking`|string|Yes|Order tracking code|
|`tel`|string|No|New phone number (10 digits)|
|`adresse`|string|No|New address (used with `commune`)|
|`wilaya`|integer|No|Must match the current order wilaya (otherwise error)|
|`commune`|string|No|New commune (required together with `adresse`)|
|`montant`|numeric|No|New amount|
|`type`|integer|No|New shipment type (1-3)|
|`stop_desk`|integer|No|New delivery mode (0=Home, 1=Stop desk)|
|`code_station`|string|No|Required if `stop_desk=1` when switching to stop desk|



## Business Rules 

- If the order is En livraison (in delivery), only `type` and `montant` can be changed. 

- For home delivery, `commune` and `adresse` must be provided together. 

- For stop desk ( `stop_desk=1` ), `code_station` is required and must belong to the same wilaya as the order. 

- If no valid editable field is provided, the request is rejected. 

11 / 29 

2026-05-06 

## Request Example 

```
{
  "tracking": "TRK123456789",
  "tel": "0551234567",
  "stop_desk": 1,
  "code_station": "16B",
  "montant": 4000
}
```

## Success Response 

```
{
  "success": true,
  "message": "La demande a été envoyée avec succès !"
}
```

## Common Error Messages 

|Error|Description|
|---|---|
|`Commande non trouvée dans l'étape de`|Order does not exist, has already been shipped, or|
|`modification`|does not belong to the partner|
|`Vous ne pouvez pas modifier la wilaya`<br>`de cette commande`|Provided wilaya differs from the order wilaya|
|`Le code station est obligatoire pour`<br>`une livraison stop desk`|`stop_desk=1` without `code_station`|
|`Station non trouvée dans la wilaya de`<br>`cette commande`|Station is invalid for the order wilaya|
|`Il faut saisir l'adresse de cette`||
|`commande`|`commune` provided without `adresse`|
|`Il faut saisir la commune de cette`||
|`commande`|`adresse` provided without `commune`|
|`Aucune demande de modification !`|No valid modification was detected|



## 5.1. Update an Order Before Expedition 

Directly modifies an existing order that has not yet been shipped. Unlike endpoint 5, this applies changes immediately without creating a modification request. 

## ⚠ Important: 

12 / 29 

2026-05-06 

- `tracking` is required and must belong to the authenticated partner. 

- The order must not have been shipped yet. 

- Only the fields provided will be updated; omitted fields remain unchanged. 

## Endpoint 

```
POST /api/public/update/order/before/expedition
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`tracking`|string|Yes|Order tracking code|
|`reference`|string|No|Order reference|
|`client`|string|No|Customer full name|
|`tel`|string|No|Primary phone number (10 digits)|
|`tel2`|string|No|Secondary phone number (10 digits)|
|`adresse`|string|No|Delivery address|
|`wilaya`|numeric|No|WilayaID|
|`commune`|string|No|Commune name|
|`montant`|numeric|No|Order amount|
|`remarque`|string|No|Remarks (max: 255 characters)|
|`product`|string|No|Product name/reference|
|`type`|integer|No|Shipment type (1=Delivery, 2=Exchange, 3=Pick-up)|
|`poids`|string|No|Package weight|
|`stop_desk`|integer|No|Delivery mode (0=Home, 1=Stop desk)|



## Request Example 

```
{
  "tracking": "TRK123456789",
```

13 / 29 

2026-05-06 

```
  "client": "Ahmed Ahmed",
  "tel": "0550000000",
  "montant": 4500,
  "adresse": "Rue des Martyrs, Bab Ezzouar",
  "commune": "Bab Ezzouar"
}
```

## Success Response 

```
{
  "success": true
}
```

## Error Response 

```
{
  "success": false,
  "message": "Commande non trouvée dans l'étape de modification"
}
```

## Common Error Messages 

|Error|Description|
|---|---|
|`Commande non trouvée dans l'étape de`|Order not found, already shipped, or does not|
|`modification`|belong to the partner|



## 6. Delete an Order 

Delete an unvalidated order. 

⚠ Important: Only unvalidated orders can be deleted. 

## Endpoint 

```
POST /api/public/delete/order
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

14 / 29 

2026-05-06 

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`user_guid`|string|Yes|PartnerGUID|
|`tracking`|string|Yes|Order tracking code|



## Request Example 

```
{
  "user_guid": "abc123-def456-ghi789",
  "tracking": "TRK123456789"
}
```

## Success Response 

```
{
  "success": true
}
```

## Error Response 

```
{
  "success": false
}
```

## 7. Add a Remark 

Add an update or remark to an order. 

## Endpoint 

```
POST /api/public/add/maj
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

15 / 29 

2026-05-06 

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`tracking`|string|Yes|Order tracking code|
|`content`|string|Yes|Remark content (max: 255 characters)|



## Request Example 

```
{
  "tracking": "TRK123456789",
  "content": "Customer prefers afternoon delivery"
}
```

## Success Response 

```
{
  "success": true,
  "message": "Mise a jour avec success"
}
```

## Common Error Messages 

## Error Description 

`Commande inexistante` Order does not exist or does not belong to the partner 

## 8. Request a New Delivery Attempt 

Request a new delivery attempt for an order. 

## Endpoint 

```
POST /api/public/ask/new-tentative
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

16 / 29 

2026-05-06 

## Parameters 

|Parameter|Type|Required|Description|
|---|---|---|---|
|`tracking`|string|Yes|Order tracking code|



## Request Example 

```
{
  "tracking": "TRK123456789"
}
```

## Success Response 

```
{
  "success": true
}
```

## 9. Request a Return 

Request the return of an order to the partner. 

## Endpoint 

```
POST /api/public/ask/return
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

Parameter Type Required Description `tracking` string Yes Order tracking code 

## Request Example 

**==> picture [512 x 35] intentionally omitted <==**

17 / 29 

2026-05-06 

```
{
  "tracking": "TRK123456789"
}
```

## Success Response 

```
{
  "success": true
}
```

## 10. Download Delivery Slip 

Download the order label (delivery slip) in PDF format. 

## Endpoint 

```
GET /api/public/get/order/label
```

## Headers 

```
Authorization: Bearer {token}
```

## Parameters (Query String) 

Parameter Type Required Description `tracking` string Yes Order tracking code 

## Request Example 

```
GET /api/public/get/order/label?tracking=TRK123456789
```

## Response 

Returns a downloadable PDF file containing the delivery label. 

📊 Order Tracking 

18 / 29 

2026-05-06 

## 11. Get Information for Multiple Orders 

Retrieve detailed information and history for multiple orders. 

## Endpoint 

```
POST /api/public/get/trackings/info
```

## Headers 

```
Authorization: Bearer {token}
Content-Type: application/json
```

## Parameters 

Parameter Type Required Description `trackings` array Yes Array of tracking codes 

## Request Example 

```
{
  "trackings": [
"TRK123456789",
"TRK987654321"
  ]
}
```

## Success Response 

```
{
  "TRK123456789": {
    "OrderInfo": {
      "tracking": "TRK123456789",
      "reference": "REF0001",
      "client": "Ahmed Benali",
      "phone": "0550505050",
      "phone_2": null,
      "adresse": "Bab Ezzouar, Alger",
      "wilaya_id": 16,
      "commune": "Bab Ezzouar",
      "montant": "3500.00",
""
      "remarque": ,
      "produit": "Smartphone Samsung",
```

19 / 29 

2026-05-06 

```
      "driver_name": "Driver 001",
      "driver_tel": "0550000000",
      "type_id": 1,
      "stop_desk": 0,
      "created_at": "2024-01-15T12:45:04.000000Z"
    },
    "recipientName": "Ahmed Benali",
    "shippedBy": "Electronics Store",
    "originCity": 16,
    "destLocationCity": 16,
    "activity": [
      {
        "event": "Uploaded to system",
        "causer": "PARTNER",
        "badge-class": "badge-success",
        "by": "Electronics Store",
        "name": "",
        "driver": "",
        "fdr": "",
        "date": "2024-01-15 12:45:04"
      },
      {
        "event": "Validated",
        "causer": "PARTNER",
        "badge-class": "badge-success",
        "by": "Electronics Store",
        "name": "",
        "driver": "",
        "fdr": "",
        "date": "2024-01-15 13:20:15"
      }
    ],
    "deliveryAttempts": []
  },
  "TRK987654321": {
    "OrderInfo": {
      "tracking": "TRK987654321",
      "reference": "REF0002",
      "client": "Fatima Zahra",
      "phone": "0660606060",
      "phone_2": null,
      "adresse": "Cité 300 logements",
      "wilaya_id": 16,
      "commune": "Dar El Beida",
      "montant": "2000.00",
""
      "remarque": ,
      "produit": "Bluetooth Earphones",
      "driver_name": "Driver 002",
      "driver_tel": "0551111111",
      "type_id": 1,
      "stop_desk": 0,
      "created_at": "2024-01-15T14:30:22.000000Z"
    },
    "recipientName": "Fatima Zahra",
```

20 / 29 

2026-05-06 

```
    "shippedBy": "Electronics Store",
    "originCity": 16,
    "destLocationCity": 16,
    "activity": [
      {
        "event": "Return dispatched to partner",
        "event_key": "return_dispatched_to_partenaire",
        "causer": "NOEST",
        "badge-class": "badge-primary",
""
        "by": ,
        "name": "",
        "driver": "",
        "fdr": "",
        "date": "2024-01-20 10:18:12"
      }
    ],
    "deliveryAttempts": []
  }
}
```

Error Response 

```
{
  "message": "Trackings not found"
}
```

Note: Orders are searched in both active and archived orders. 

## 📋 Event List 

Complete list of possible events in an order's history: 

|EventKey|Event|Description|
|---|---|---|
|`upload`|Uploaded to system|Order created|
|`customer_validation`|Validated|Order validated by<br>partner|
|`validation_collect_colis`|PackagePicked Up|Package collected<br>from partner|
|`validation_reception_admin`|Reception validated|Reception validated<br>by admin|
|`validation_reception`|Picked up by driver|Package taken over<br>by driver|



21 / 29 

2026-05-06 

||EventKey<br>Event<br>Description<br>`fdr_activated`<br>Out for delivery<br>Route sheet<br>activated<br>`sent_to_redispatch`<br>Sent for redispatch<br>Being reassigned<br>`nouvel_tentative_asked_by_customer`<br>New attempt requested by<br>seller<br>New attempt<br>requested<br>`return_asked_by_customer`<br>Return requested by<br>partner<br>Return requested<br>`return_asked_by_hub`<br>Return in transit<br>Return in progress<br>`retour_dispatched_to_partenaires`<br>Return dispatched to<br>partner<br>Return shipped to<br>partner<br>`return_dispatched_to_partenaire`<br>Return dispatched to<br>partner<br>Return shipped to<br>partner<br>`colis_retour_transmit_to_partner`<br>Return package<br>transmitted to partner<br>Return transmitted<br>`colis_pickup_transmit_to_partner`<br>Pick-UPtransmitted to<br>partner<br>Pick-up transmitted<br>`annulation_dispatch_retour`<br>Return transmission to<br>partner cancelled<br>Transmission<br>cancelled<br>`cancel_return_dispatched_to_partenaire`<br>Return transmission<br>cancelled<br>Cancellation<br>`livraison_echoue_recu`<br>Return received by partner<br>Return received<br>`return_validated_by_partener`<br>Return validated by<br>partner<br>Return confirmed<br>`return_redispatched_to_livraison`<br>Return put back for<br>delivery<br>New attempt<br>`return_dispatched_to_warehouse`<br>Return dispatched to<br>warehouse<br>Sent to warehouse<br>`pickedup`<br>Pick-Up collected<br>Pick-up completed<br>`valid_return_pickup`<br>Pick-Up validated<br>Pick-up confirmed<br>`pickup_picked_recu`<br>Pick-Up received by<br>partner<br>Pick-up received<br>`colis_suspendu`<br>Suspended<br>Order suspended<br>`livre`<br>Delivered<br>Order delivered<br>`livred`<br>Delivered<br>Order delivered|
|---|---|



22 / 29 

2026-05-06 

|EventKey|Event|Description|
|---|---|---|
|`verssement_admin_cust`|Amount transmitted to<br>partner|Payment<br>transmitted|
|`verssement_admin_cust_canceled`|Payment cancelled|Payment cancelled|
|`verssement_hub_cust_canceled`|Payment cancelled|Payment cancelled|
|`validation_reception_cash_by_partener`|Amount received by<br>partner|Payment received|
|`echange_valide`|Exchange validated|Exchange confirmed|
|`echange_valid_by_hub`|Exchange validated by hub|Exchange confirmed|
|`ask_to_delete_by_admin`|Deletion requested|Deletion requested<br>by admin|
|`ask_to_delete_by_hub`|Deletion requested|Deletion requested<br>by hub|
|`edited_informations`|Information modified|Info modification|
|`edit_price`|Price modified|Amount modified|
|`edit_wilaya`|Wilaya change|Wilaya modified|
|`extra_fee`|Package surcharge|Additional fees|
|`mise_a_jour`|Delivery attempt|Attempt made|



## 🏢 Reference Data 

## 12. List of Offices (Stations/Stop Desk) 

Retrieve the list of all available delivery points (Stop Desk). 

## Endpoint 

```
GET /api/public/desks
```

## Headers 

```
Authorization: Bearer {token}
```

## Request Example 

**==> picture [512 x 31] intentionally omitted <==**

23 / 29 

2026-05-06 

```
GET /api/public/desks
```

## Success Response 

```
{
  "01A": {
    "code": "1A",
    "name": "Adrar",
    "address": "Cité les palmier en face l'hopital",
""
    "map": ,
    "phones": {
      "0": "0550602181",
      "1": "0561623531",
      "2": "",
      "3": ""
    },
    "email": "adrar@noest-dz.com"
  },
  "02A": {
    "code": "2A",
    "name": "Chlef",
    "address": "Rue Lac des Forêts (À côté du CNRC)",
""
    "map": ,
    "phones": {
      "0": "0770582116",
      "1": "0561686360",
      "2": "",
      "3": ""
    },
    "email": "chlef@noest-dz.com"
  }
}
```

## 13. List of Delivery Fees 

Retrieve the partner's customized pricing grid. 

## Endpoint 

```
GET /api/public/fees
```

## Headers 

```
Authorization: Bearer {token}
```

24 / 29 

2026-05-06 

## Request Example 

```
GET /api/public/fees
```

## Success Response 

```
{
  "tarifs": {
    "return": {
      "16": {
        "tarif_id": 400,
        "wilaya_id": 16,
        "tarif": "300",
        "tarif_stopdesk": "300"
      },
      "9": {
        "tarif_id": 400,
        "wilaya_id": 9,
        "tarif": "300",
        "tarif_stopdesk": "300"
      }
    },
    "delivery": {
      "16": {
        "tarif_id": 399,
        "wilaya_id": 16,
        "tarif": "700",
        "tarif_stopdesk": "300"
      },
      "9": {
        "tarif_id": 399,
        "wilaya_id": 9,
        "tarif": "800",
        "tarif_stopdesk": "350"
      }
    }
  }
}
```

## Structure: 

`return` : Return fees per wilaya 

`delivery` : Delivery fees per wilaya `tarif` : Home delivery price (in DZD) `tarif_stopdesk` : Relay point price (in DZD) 

25 / 29 

2026-05-06 

## 14. List of Communes 

Retrieve the list of deliverable communes, optionally filtered by wilaya. 

## Endpoint 

```
GET /api/public/get/communes/{wilaya_id}
```

## Headers 

```
Authorization: Bearer {token}
```

## Parameters 

Parameter Type Required Description 

`wilaya_id` integer No Wilaya ID (1-58) to filter 

## Request Example 

All communes: 

```
GET /api/public/get/communes
```

Communes of a specific wilaya: 

```
GET /api/public/get/communes/5
```

## Success Response 

```
[
  {
    "nom": "Batna",
    "wilaya_id": 5,
    "code_postal": "05001",
    "is_active": 1
  },
  {
    "nom": "Ghassira",
    "wilaya_id": 5,
    "code_postal": "05002",
    "is_active": 1
```

26 / 29 

2026-05-06 

```
  },
  {
    "nom": "Maafa",
    "wilaya_id": 5,
    "code_postal": "05003",
    "is_active": 1
  },
  {
    "nom": "Merouana",
    "wilaya_id": 5,
    "code_postal": "05004",
    "is_active": 1
  },
  {
    "nom": "Seriana",
    "wilaya_id": 5,
    "code_postal": "05005",
    "is_active": 1
  }
]
```

## 15. List of Wilayas 

Retrieve the list of all Algerian wilayas. 

## Endpoint 

```
GET /api/public/get/wilayas
```

## Headers 

```
Authorization: Bearer {token}
```

## Request Example 

```
GET /api/public/get/wilayas
```

## Success Response 

```
[
  {
    "code": 1,
```

27 / 29 

2026-05-06 

```
    "nom": "Adrar",
    "is_active": 1
  },
  {
    "code": 2,
    "nom": "Chlef",
    "is_active": 1
  },
  {
    "code": 3,
    "nom": "Laghouat",
    "is_active": 1
  },
  {
    "code": 4,
    "nom": "Oum El Bouaghi",
    "is_active": 1
  },
  {
    "code": 5,
    "nom": "Batna",
    "is_active": 1
  }
]
```

## 📝 Important Notes 

## Limits and Constraints 

- Bulk creation: Maximum 100 orders per request 

- Bulk validation: Maximum 100 trackings per request 

- Rate limiting: 60 requests per minute by default 

- Authentication: Bearer token required for all endpoints 

- Timeout: 30 seconds timeout per request 

## Error Handling 

- If at least one order fails in a bulk operation, `success` will be `false` 

- Keys in `passed` and `failed` correspond to array indices for creation 

- Keys in `passed` and `failed` correspond to trackings for validation 

- Validation errors return HTTP 422 code with details 

## Recommended Workflow 

0. Create an order with `POST /api/public/create/order` or `/create/orders` 

2. Verify information if necessary 

3. Modify with `POST /api/public/update/order` (if not validated) 

4. Validate with `POST /api/public/valid/order` or `/valid/orders` 

6. Download label with `GET /api/public/get/order/label` 

28 / 29 

2026-05-06 

## 7. Track with `POST /api/public/get/trackings/info` 

## Stop Desk 

- If `stop_desk=1` , the `station_code` field becomes mandatory 

- The station code must match the destination wilaya 

- Use `/api/public/desks` to get the list of available codes 

## Expedition station 

- The `station_expedition` field allows you to send a specific expedition station for the order 

- This feature must be explicitly enabled for your partner account; otherwise the value will be rejected 

## Postal Code (zip_code) 

- If `zip_code` is provided, it automatically replaces `wilaya_id` and `commune` 

- The postal code must exist in the database 

- Use `/api/public/get/communes` to get valid postal codes 

## Stock 

- If `stock=1` , the `quantite` field becomes mandatory 

- Product references must be separated by commas in the `produit` field 

- Corresponding quantities must be separated by commas in `quantite` 

- Example: `produit="PROD001,PROD002"` and `quantite="2,3"` 

## Order Types 

- Type 1 (Delivery): Standard delivery with collection 

- Type 2 (Exchange): Product exchange with customer 

- Type 3 (Pick-up): Package collection from customer (amount forced to 0) 

## Refund/Collection 

- If `remboursement=1` and `montant < 0` : Refund request to customer 

- If `remboursement=1` and `montant > 0` : Collection request from customer 

- This feature must be enabled for your account 

## 🆘 Support 

- For any questions or technical issues, contact NOEST support: 

   - Email: api@noest-dz.com 

Version: 2.3 Last updated: May 2026 

29 / 29 

