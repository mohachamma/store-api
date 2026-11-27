#!/usr/bin/env python3
"""Generates supabase/migrations/20261130000009_pages.sql: the `pages` table and the first DRAFT texts (ar / fr / en).

The texts are plain Markdown-like text: `## Heading`, `- list item`, `**bold**`, blank line = new paragraph.
Run: python3 scripts/gen-legal.py
"""
import json
import pathlib

DRAFT_NOTE = {
    "ar": "مسودة — يجب أن يراجعها محامٍ قبل الإطلاق.",
    "fr": "Brouillon — à faire relire par un avocat avant le lancement.",
    "en": "Draft — have it reviewed by a lawyer before launch.",
}

PAGES = {
    "terms": {
        "order": 1,
        "title": {"ar": "الشروط والأحكام", "fr": "Conditions générales de vente", "en": "Terms and conditions"},
        "body": {
            "ar": """## 1. القبول
باستعمالك هذا المتجر أو إتمامك طلباً فيه، فإنك توافق على هذه الشروط. إن لم توافق عليها فلا تُتمّ الطلب.

## 2. الطلب والتأكيد
- الطلب عبر الموقع هو **عرض شراء** منك، ولا يصبح عقداً إلا بعد أن نتصل بك هاتفياً ونؤكد الطلب.
- يجب أن تكون بيانات الاتصال والعنوان صحيحة، وإلا قد نتعذر عن تأكيد الطلب أو تسليمه.
- يحق لنا إلغاء أي طلب لم يمكن تأكيده أو يبدو وهمياً، مع إعادة المخزون.

## 3. الأسعار
- الأسعار بالدينار الجزائري كما تظهر لحظة الطلب، ويحسبها خادمنا نفسه ولا تعتمد على ما يرسله المتصفح.
- رسوم التوصيل تظهر قبل تأكيد الطلب وتختلف بحسب الولاية ونوع التوصيل.
- قد تتغير الأسعار والعروض في أي وقت، ولا يؤثر ذلك على طلب تم تأكيده.

## 4. التوفر
المنتجات المعروضة خاضعة للمخزون المتوفر. إذا نفد منتج بعد طلبك نتصل بك لنقترح بديلاً أو نلغي الطلب.

## 5. الدفع
- الدفع نقداً عند الاستلام، أو ببطاقة CIB / الذهبية عبر منصة Chargily.
- لا نحتفظ ببيانات بطاقتك البنكية إطلاقاً: تُعالج لدى المنصة الآمنة وحدها.

## 6. التوصيل والإرجاع
تحكمهما صفحتا «سياسة التوصيل» و«الإرجاع والتبديل» وهما جزء من هذه الشروط.

## 7. الحساب
إنشاء حساب اختياري. أنت مسؤول عن سرية كلمة المرور، ويمكنك طلب حذف حسابك في أي وقت.

## 8. الملكية الفكرية
الصور والنصوص والشعار ملك للمتجر ولا يجوز استعمالها دون إذن كتابي.

## 9. المسؤولية
نبذل جهدنا ليكون وصف المنتجات وصورها دقيقاً، وقد تختلف الألوان قليلاً بحسب شاشتك. لا نتحمل أضراراً غير مباشرة ناتجة عن استعمال الموقع.

## 10. تعديل الشروط
قد نعدّل هذه الشروط، وتسري النسخة المنشورة وقت طلبك.

## 11. القانون المطبق
يخضع هذا العقد للقانون الجزائري، وتختص المحاكم الجزائرية بأي نزاع. [اكتب هنا اسم الشركة وعنوانها ورقم السجل التجاري].""",
            "fr": """## 1. Acceptation
En utilisant cette boutique ou en passant commande, vous acceptez les présentes conditions. Si vous ne les acceptez pas, ne passez pas commande.

## 2. Commande et confirmation
- Une commande passée sur le site est une **offre d'achat** de votre part ; elle ne devient un contrat qu'après notre appel téléphonique de confirmation.
- Vos coordonnées et votre adresse doivent être exactes, faute de quoi nous pourrions ne pas pouvoir confirmer ou livrer la commande.
- Nous pouvons annuler toute commande impossible à confirmer ou qui paraît fictive ; le stock est alors remis en vente.

## 3. Prix
- Les prix sont en dinars algériens, tels qu'affichés au moment de la commande. Ils sont calculés par notre serveur et non par votre navigateur.
- Les frais de livraison sont affichés avant la confirmation et varient selon la wilaya et le mode de livraison.
- Les prix et offres peuvent changer à tout moment, sans effet sur une commande déjà confirmée.

## 4. Disponibilité
Les produits sont proposés dans la limite des stocks. Si un article n'est plus disponible après votre commande, nous vous appelons pour proposer une alternative ou annuler.

## 5. Paiement
- Paiement en espèces à la livraison, ou par carte CIB / Edahabia via Chargily.
- Nous ne conservons jamais vos données bancaires : elles sont traitées uniquement par la plateforme de paiement sécurisée.

## 6. Livraison et retours
Ils sont régis par les pages « Livraison » et « Retours et échanges », qui font partie des présentes conditions.

## 7. Compte
La création d'un compte est facultative. Vous êtes responsable de la confidentialité de votre mot de passe et pouvez demander la suppression de votre compte à tout moment.

## 8. Propriété intellectuelle
Les photos, textes et logo appartiennent à la boutique et ne peuvent être utilisés sans autorisation écrite.

## 9. Responsabilité
Nous veillons à la précision des descriptions et photos ; les couleurs peuvent légèrement varier selon votre écran. Nous ne répondons pas des dommages indirects liés à l'usage du site.

## 10. Modification des conditions
Nous pouvons modifier ces conditions ; la version publiée au moment de votre commande s'applique.

## 11. Droit applicable
Le présent contrat est soumis au droit algérien ; les tribunaux algériens sont compétents. [Indiquez ici la raison sociale, l'adresse et le numéro de registre du commerce].""",
            "en": """## 1. Acceptance
By using this store or placing an order you accept these terms. If you do not accept them, please do not place an order.

## 2. Orders and confirmation
- An order placed on the website is a **purchase offer** from you; it only becomes a contract after we phone you and confirm it.
- Your contact details and address must be correct, otherwise we may be unable to confirm or deliver the order.
- We may cancel any order we cannot confirm or that looks fake; the stock is then released.

## 3. Prices
- Prices are in Algerian dinars as shown when you order. Our server calculates them, not your browser.
- Delivery fees are shown before you confirm and depend on the wilaya and delivery type.
- Prices and offers may change at any time without affecting an order already confirmed.

## 4. Availability
Products are offered while stock lasts. If an item runs out after your order, we call you to suggest an alternative or cancel.

## 5. Payment
- Cash on delivery, or CIB / Edahabia card through Chargily.
- We never keep your card details: they are handled only by the secure payment platform.

## 6. Delivery and returns
They are governed by the "Shipping" and "Returns and exchanges" pages, which are part of these terms.

## 7. Account
An account is optional. You are responsible for keeping your password secret and can ask us to delete your account at any time.

## 8. Intellectual property
Photos, texts and the logo belong to the store and may not be used without written permission.

## 9. Liability
We do our best to keep descriptions and photos accurate; colors may vary slightly on your screen. We are not liable for indirect damage from using the site.

## 10. Changes to these terms
We may update these terms; the version published when you order applies.

## 11. Governing law
This contract is governed by Algerian law and Algerian courts have jurisdiction. [Write the company name, address and commercial register number here].""",
        },
    },
    "privacy": {
        "order": 2,
        "title": {"ar": "سياسة الخصوصية", "fr": "Politique de confidentialité", "en": "Privacy policy"},
        "body": {
            "ar": """نحترم خصوصيتك ونعمل وفق القانون الجزائري رقم 18-07 المتعلق بحماية الأشخاص الطبيعيين في مجال معالجة المعطيات ذات الطابع الشخصي. نشرح هنا بصراحة ما نجمعه ولماذا.

## 1. ما الذي نجمعه
- **عند الطلب:** الاسم، رقم الهاتف، الولاية والبلدية والعنوان.
- **عند إنشاء حساب (اختياري):** البريد الإلكتروني وكلمة المرور (تحفظها خدمة المصادقة مشفّرة)، والاسم والهاتف إن أدخلتهما.
- **عند الاشتراك في النشرة:** بريدك الإلكتروني فقط.
- **في جهازك:** سلة المشتريات والمفضلة تُحفظ في متصفحك، وملف جلسة عند تسجيل الدخول.

## 2. لماذا نستعمل بياناتك
لتأكيد طلبك هاتفياً وتوصيله، وللتواصل معك بشأنه، ولإدارة حسابك، ولإرسال جديدنا إن اشتركت في النشرة.

## 3. ما نفعله ببيانات الطلب
- نحتفظ بالاسم والهاتف والعنوان **فقط إلى أن نؤكد طلبك**.
- عند التأكيد **نرسلها مباشرة إلى شركة التوصيل** لتوصيل الطرد، ثم **نحذفها نهائياً من نظامنا**. نحتفظ فقط برقم الطلب والمنتجات والمبالغ وطريقة الدفع والولاية ورقم التتبع.
- الطلبات التي لا تُؤكَّد خلال 14 يوماً تُلغى وتُحذف بياناتها.

## 4. من نشاركه بياناتك
- **شركة التوصيل:** الاسم والهاتف والعنوان لتوصيل الطرد، وهي مسؤولة عن بياناتها وفق سياستها.
- **منصة الدفع (Chargily):** عند الدفع بالبطاقة فقط. لا نرى بيانات بطاقتك.
- لا نبيع بياناتك ولا نشاركها لأغراض إعلانية.

## 5. حقوقك
يحق لك الاطلاع على بياناتك وتصحيحها والاعتراض على معالجتها وطلب حذفها، بمراسلتنا عبر صفحة «تواصل معنا». ويمكنك الاتصال بالسلطة الوطنية لحماية المعطيات ذات الطابع الشخصي إن رأيت أن حقوقك لم تُحترم.

## 6. الأمان
نستعمل اتصالاً مشفراً، ونحصر الوصول إلى البيانات في المصرح لهم فقط.

## 7. التعديلات
قد نحدّث هذه السياسة وننشر التاريخ الجديد في هذه الصفحة.""",
            "fr": """Nous respectons votre vie privée et agissons conformément à la loi algérienne n° 18-07 relative à la protection des personnes physiques dans le traitement des données à caractère personnel. Voici, en toute franchise, ce que nous collectons et pourquoi.

## 1. Ce que nous collectons
- **À la commande :** nom, numéro de téléphone, wilaya, commune et adresse.
- **À la création d'un compte (facultatif) :** e-mail et mot de passe (conservé chiffré par le service d'authentification), plus nom et téléphone si vous les saisissez.
- **À l'inscription à la newsletter :** votre e-mail uniquement.
- **Sur votre appareil :** panier et favoris sont stockés dans votre navigateur, ainsi qu'un cookie de session lorsque vous êtes connecté.

## 2. Pourquoi nous utilisons vos données
Pour confirmer votre commande par téléphone et la livrer, vous contacter à son sujet, gérer votre compte et, si vous vous êtes inscrit, vous envoyer nos nouveautés.

## 3. Ce que nous faisons des données de commande
- Nous conservons nom, téléphone et adresse **uniquement jusqu'à la confirmation** de votre commande.
- À la confirmation, nous les **transmettons directement à la société de livraison** pour acheminer le colis, puis nous les **supprimons définitivement de notre système**. Nous ne gardons que le numéro de commande, les articles, les montants, le mode de paiement, la wilaya et le numéro de suivi.
- Les commandes non confirmées sous 14 jours sont annulées et leurs données effacées.

## 4. Avec qui nous partageons vos données
- **La société de livraison :** nom, téléphone et adresse pour livrer le colis ; elle est responsable de ses propres traitements.
- **La plateforme de paiement (Chargily) :** uniquement en cas de paiement par carte. Nous ne voyons pas vos données bancaires.
- Nous ne vendons pas vos données et ne les partageons pas à des fins publicitaires.

## 5. Vos droits
Vous pouvez accéder à vos données, les rectifier, vous opposer à leur traitement et demander leur suppression en nous écrivant via la page « Contact ». Vous pouvez saisir l'Autorité nationale de protection des données à caractère personnel si vous estimez que vos droits ne sont pas respectés.

## 6. Sécurité
Nous utilisons une connexion chiffrée et limitons l'accès aux données aux personnes autorisées.

## 7. Modifications
Nous pouvons mettre à jour cette politique et publier la nouvelle date sur cette page.""",
            "en": """We respect your privacy and act in line with Algerian law no. 18-07 on the protection of individuals in the processing of personal data. Here is, plainly, what we collect and why.

## 1. What we collect
- **When you order:** name, phone number, wilaya, commune and address.
- **When you create an account (optional):** email and password (kept encrypted by the authentication service), plus name and phone if you enter them.
- **When you join the newsletter:** your email only.
- **On your device:** your cart and favorites are stored in your browser, plus a session cookie when you are signed in.

## 2. Why we use your data
To confirm your order by phone and deliver it, to contact you about it, to manage your account and, if you subscribed, to send you our news.

## 3. What we do with order data
- We keep your name, phone and address **only until we confirm your order**.
- On confirmation we **send them directly to the delivery company** to carry the parcel, then **delete them permanently from our system**. We only keep the order number, items, amounts, payment method, wilaya and tracking number.
- Orders not confirmed within 14 days are cancelled and their data erased.

## 4. Who we share it with
- **The delivery company:** name, phone and address to deliver the parcel; it is responsible for its own processing.
- **The payment platform (Chargily):** only if you pay by card. We never see your card details.
- We do not sell your data or share it for advertising.

## 5. Your rights
You may access, correct, object to the processing of, and ask us to delete your data by writing to us through the "Contact" page. You may contact the national authority for the protection of personal data if you believe your rights are not respected.

## 6. Security
We use an encrypted connection and limit access to data to authorized people.

## 7. Changes
We may update this policy and publish the new date on this page.""",
        },
    },
    "returns": {
        "order": 3,
        "title": {"ar": "الإرجاع والتبديل", "fr": "Retours et échanges", "en": "Returns and exchanges"},
        "body": {
            "ar": """نريد أن تكون راضياً عن طلبك. إليك كيف يتم الإرجاع والتبديل.

## 1. المدة
يمكنك طلب الإرجاع أو التبديل خلال **7 أيام** من استلام الطلب. [عدّل المدة حسب سياسة متجرك].

## 2. الشروط
- القطعة غير مستعملة وغير مغسولة، بحالتها الأصلية ومعها الملصقات والتغليف.
- لا تُقبل بعض المنتجات لأسباب صحية (مثل الملابس الداخلية) إلا إذا كان بها عيب.

## 3. كيف تطلب
تواصل معنا عبر صفحة «تواصل معنا» أو الهاتف، واذكر رقم الطلب والسبب. نرتب معك طريقة إرجاع القطعة.

## 4. التبديل
المقاس غير مناسب؟ نبدّل القطعة بمقاس أو لون آخر حسب التوفر.

## 5. الاسترجاع المالي
إن لم يتوفر البديل نسترجع لك المبلغ بالطريقة نفسها التي دفعت بها: نقداً عند استلام الإرجاع، أو إلى بطاقتك إن دفعت بالبطاقة.

## 6. التكاليف
تكاليف الإرجاع على عاتقنا إن كان العيب منا (قطعة خاطئة أو معيبة)، وعلى عاتقك إن كان السبب تغيير رأيك. [عدّل هذا البند حسب سياستك].

## 7. القطعة المعيبة أو الخاطئة
افحص الطرد عند الاستلام وأخبرنا فوراً إن وجدت عيباً أو قطعة غير التي طلبتها.""",
            "fr": """Nous voulons que vous soyez satisfait de votre commande. Voici comment fonctionnent retours et échanges.

## 1. Délai
Vous pouvez demander un retour ou un échange dans les **7 jours** suivant la réception. [Ajustez ce délai selon la politique de votre boutique].

## 2. Conditions
- Article non porté et non lavé, dans son état d'origine, avec étiquettes et emballage.
- Certains produits ne sont pas repris pour des raisons d'hygiène (ex. sous-vêtements), sauf défaut.

## 3. Comment faire
Contactez-nous via la page « Contact » ou par téléphone en indiquant le numéro de commande et le motif. Nous convenons avec vous de la façon de nous renvoyer l'article.

## 4. Échange
Taille inadaptée ? Nous échangeons contre une autre taille ou couleur selon disponibilité.

## 5. Remboursement
Si l'échange est impossible, nous vous remboursons de la même manière que votre paiement : en espèces à la réception du retour, ou sur votre carte si vous avez payé par carte.

## 6. Frais
Les frais de retour sont à notre charge si l'erreur vient de nous (article erroné ou défectueux), et à la vôtre si vous changez d'avis. [Ajustez selon votre politique].

## 7. Article défectueux ou erroné
Vérifiez le colis à la réception et signalez-nous immédiatement tout défaut ou article différent de votre commande.""",
            "en": """We want you to be happy with your order. Here is how returns and exchanges work.

## 1. Time limit
You can ask for a return or exchange within **7 days** of receiving your order. [Adjust this to your store's policy].

## 2. Conditions
- The item must be unworn and unwashed, in its original condition with tags and packaging.
- Some products are not accepted back for hygiene reasons (e.g. underwear) unless faulty.

## 3. How to ask
Contact us through the "Contact" page or by phone with your order number and the reason. We will arrange with you how to send the item back.

## 4. Exchanges
Wrong size? We swap it for another size or color, subject to availability.

## 5. Refunds
If no replacement is available we refund you the same way you paid: in cash when we receive the return, or to your card if you paid by card.

## 6. Costs
Return costs are on us if the mistake is ours (wrong or faulty item), and on you if you changed your mind. [Adjust to your policy].

## 7. Faulty or wrong item
Check the parcel when you receive it and tell us right away about any defect or an item different from your order.""",
        },
    },
    "shipping": {
        "order": 4,
        "title": {"ar": "سياسة التوصيل", "fr": "Livraison", "en": "Shipping and delivery"},
        "body": {
            "ar": """## 1. مناطق التوصيل
نوصّل إلى **58 ولاية**. يمكنك اختيار التوصيل **إلى المنزل** أو **إلى مكتب شركة التوصيل** القريب منك.

## 2. الرسوم
تظهر رسوم التوصيل في صفحة إتمام الطلب قبل التأكيد، وتختلف بحسب الولاية ونوع التوصيل. قد يكون التوصيل مجانياً عندما يبلغ مجموع الطلب حداً معيناً يظهر في المتجر.

## 3. كيف يتم الطلب
- بعد إرسال طلبك **نتصل بك هاتفياً** لتأكيده.
- بعد التأكيد نسلّم الطرد لشركة التوصيل ونعطيك **رقم التتبع**.
- تتصل بك شركة التوصيل لترتيب الاستلام.

## 4. مدة التوصيل
غالباً من **2 إلى 5 أيام عمل** بعد التأكيد بحسب الولاية. [عدّل المدة حسب شركة التوصيل]. هذه مدة تقديرية وليست التزاماً.

## 5. عند الاستلام
- كن متاحاً على الهاتف المسجّل في الطلب.
- افحص الطرد أمام المندوب قبل الدفع أو التوقيع.
- إن تعذّر التسليم أكثر من مرة قد يُلغى الطلب.

## 6. بياناتك
نرسل اسمك وهاتفك وعنوانك لشركة التوصيل وحدها، ثم نحذفها من نظامنا كما توضح سياسة الخصوصية.""",
            "fr": """## 1. Zones de livraison
Nous livrons dans **58 wilayas**. Vous pouvez choisir la livraison **à domicile** ou **en point relais** de la société de livraison près de chez vous.

## 2. Frais
Les frais de livraison sont affichés au moment de la commande, avant confirmation, et varient selon la wilaya et le mode de livraison. La livraison peut être gratuite à partir d'un certain montant de commande, affiché dans la boutique.

## 3. Déroulement
- Après l'envoi de votre commande, **nous vous appelons** pour la confirmer.
- Une fois confirmée, nous remettons le colis à la société de livraison et vous donnons le **numéro de suivi**.
- La société de livraison vous contacte pour convenir de la remise.

## 4. Délais
En général **2 à 5 jours ouvrés** après confirmation selon la wilaya. [Ajustez selon votre transporteur]. Ce délai est indicatif et non contractuel.

## 5. À la réception
- Soyez joignable au numéro indiqué dans la commande.
- Vérifiez le colis devant le livreur avant de payer ou de signer.
- Si la livraison échoue plusieurs fois, la commande peut être annulée.

## 6. Vos données
Nous transmettons votre nom, téléphone et adresse uniquement à la société de livraison, puis nous les supprimons de notre système comme l'explique la politique de confidentialité.""",
            "en": """## 1. Where we deliver
We deliver to **58 wilayas**. You can choose **home delivery** or **pickup at the delivery company's desk** near you.

## 2. Fees
Delivery fees are shown at checkout before you confirm and depend on the wilaya and delivery type. Delivery may be free once your order reaches a certain amount, shown in the store.

## 3. How it works
- After you send your order, **we phone you** to confirm it.
- Once confirmed, we hand the parcel to the delivery company and give you the **tracking number**.
- The delivery company contacts you to arrange the handover.

## 4. Delivery time
Usually **2 to 5 working days** after confirmation depending on the wilaya. [Adjust to your carrier]. This is an estimate, not a commitment.

## 5. On receipt
- Be reachable on the phone number given in the order.
- Check the parcel in front of the courier before paying or signing.
- If delivery fails several times, the order may be cancelled.

## 6. Your data
We send your name, phone and address only to the delivery company, then delete them from our system as explained in the privacy policy.""",
        },
    },
    "cod": {
        "order": 5,
        "title": {"ar": "الدفع عند الاستلام", "fr": "Paiement à la livraison", "en": "Cash on delivery"},
        "body": {
            "ar": """## 1. كيف يعمل
تدفع ثمن طلبك **نقداً** لمندوب التوصيل عند استلام الطرد. لا يُطلب منك أي دفع مسبق.

## 2. المبلغ
المبلغ المطلوب هو الإجمالي الظاهر في طلبك (المنتجات + التوصيل − الخصم). حضّر المبلغ كاملاً إن أمكن.

## 3. افحص قبل أن تدفع
افتح الطرد أمام المندوب وتأكد من القطع والمقاسات قبل الدفع.

## 4. تأكيد هاتفي
كل طلب بالدفع عند الاستلام **يُؤكَّد هاتفياً** قبل شحنه. يرجى الرد على اتصالنا.

## 5. رفض الاستلام
إن رفضت الاستلام دون سبب مشروع أو تكرر ذلك، قد نرفض طلباتك القادمة بهذه الطريقة. إن كان هناك عيب فاذكره للمندوب وراسلنا.

## 6. بديل: الدفع بالبطاقة
إن فضّلت الدفع مسبقاً يمكنك استعمال بطاقة CIB / الذهبية عند إتمام الطلب، إن كان الخيار ظاهراً.""",
            "fr": """## 1. Comment ça marche
Vous payez votre commande **en espèces** au livreur à la réception du colis. Aucun paiement à l'avance n'est demandé.

## 2. Montant
Le montant à régler est le total affiché dans votre commande (articles + livraison − remise). Préparez si possible la somme exacte.

## 3. Vérifiez avant de payer
Ouvrez le colis devant le livreur et vérifiez articles et tailles avant de payer.

## 4. Confirmation téléphonique
Toute commande avec paiement à la livraison est **confirmée par téléphone** avant l'expédition. Merci de répondre à notre appel.

## 5. Refus de réception
En cas de refus sans motif légitime, répété, nous pouvons refuser vos prochaines commandes avec ce mode de paiement. En cas de défaut, signalez-le au livreur et écrivez-nous.

## 6. Alternative : la carte
Si vous préférez payer à l'avance, vous pouvez utiliser votre carte CIB / Edahabia au moment de la commande, lorsque l'option est affichée.""",
            "en": """## 1. How it works
You pay for your order **in cash** to the courier when you receive the parcel. No advance payment is asked.

## 2. Amount
The amount due is the total shown in your order (items + delivery − discount). Please have the exact amount ready if you can.

## 3. Check before you pay
Open the parcel in front of the courier and check items and sizes before paying.

## 4. Phone confirmation
Every cash-on-delivery order is **confirmed by phone** before it ships. Please answer our call.

## 5. Refusing a parcel
If you refuse a parcel without a legitimate reason, repeatedly, we may decline your future orders using this method. If there is a defect, tell the courier and write to us.

## 6. Alternative: card
If you prefer to pay in advance, you can use your CIB / Edahabia card at checkout when the option is shown.""",
        },
    },
}


def lit(v):
    """A SQL string literal of a JSON value."""
    return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"


out = ["-- GENERATED by scripts/gen-legal.py — do not edit by hand. Re-run the script instead.",
       "-- Legal / information pages shown in the storefront footer, editable from the admin dashboard.",
       "-- The first texts are DRAFTS (is_draft = true): the owner must have them reviewed by a lawyer, then switch the flag off.",
       "",
       "create table public.pages (",
       "  slug         text primary key check (slug in ('terms', 'privacy', 'returns', 'shipping', 'cod')),",
       "  title        jsonb not null check (public.is_i18n(title)),",
       "  body         jsonb not null check (public.is_i18n(body)),",
       "  sort_order   integer not null default 0,",
       "  is_published boolean not null default true,",
       "  is_draft     boolean not null default true,   -- shows the \"have it reviewed by a lawyer\" notice",
       "  updated_at   timestamptz not null default now()",
       ");",
       "create trigger pages_updated before update on public.pages for each row execute function public.set_updated_at();",
       "alter table public.pages enable row level security;",
       "create policy pages_admin_all on public.pages for all to authenticated using (public.is_admin()) with check (public.is_admin());",
       "create policy pages_public_read on public.pages for select to anon, authenticated using (is_published);",
       "",
       "-- The draft notice text itself (editable) and the contact details shown on the Contact page.",
       "insert into public.site_settings (key, value) values",
       "  ('draft_notice', " + lit(DRAFT_NOTE) + "),",
       "  ('store_info', " + lit({"phone": "", "whatsapp": "", "email": "", "address": {"ar": "", "fr": "", "en": ""}, "hours": {"ar": "", "fr": "", "en": ""}}) + ")",
       "on conflict (key) do nothing;",
       "",
       "drop policy site_settings_public_read on public.site_settings;",
       "create policy site_settings_public_read on public.site_settings for select to anon, authenticated",
       "  using (key in ('announcement', 'store_info', 'brands_strip', 'sale_page', 'why_us', 'newsletter', 'draft_notice'));",
       "",
       "insert into public.pages (slug, title, body, sort_order) values"]
rows = []
for slug, p in PAGES.items():
    rows.append(f"  ('{slug}', {lit(p['title'])}, {lit(p['body'])}, {p['order']})")
out.append(",\n".join(rows) + ";")
pathlib.Path(__file__).resolve().parent.parent.joinpath("supabase/migrations/20261130000009_pages.sql").write_text("\n".join(out) + "\n")
print("written")
