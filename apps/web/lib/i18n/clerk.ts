import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";
import type { Lang } from "./core";

type ClerkLocalization = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;

/** Clerk's sign-in box in English: only the wording we changed from Clerk's own. */
const en: ClerkLocalization = {
  signIn: {
    start: { title: "Sign in", subtitle: "Use the account your team set up for you." },
    password: { title: "Enter your password", subtitle: "" },
  },
};

/**
 * Clerk's sign-in box in Albanian. Clerk has no Albanian pack of its own, so
 * this covers every screen of our sign-in: username and password, two-step
 * codes, backup codes, password reset, and the common errors.
 */
const sq: ClerkLocalization = {
  locale: "sq-AL",
  formFieldLabel__username: "Emri i përdoruesit",
  formFieldLabel__emailAddress_username: "Email ose emri i përdoruesit",
  formFieldLabel__password: "Fjalëkalimi",
  formFieldLabel__newPassword: "Fjalëkalimi i ri",
  formFieldLabel__confirmPassword: "Konfirmo fjalëkalimin",
  formFieldLabel__backupCode: "Kodi rezervë",
  formFieldInputPlaceholder__username: "Shkruaj emrin e përdoruesit",
  formFieldInputPlaceholder__password: "Shkruaj fjalëkalimin",
  formFieldAction__forgotPassword: "Harrove fjalëkalimin?",
  formFieldHintText__optional: "Opsionale",
  formButtonPrimary: "Vazhdo",
  backButton: "Kthehu",
  footerActionLink__useAnotherMethod: "Përdor një mënyrë tjetër",
  signIn: {
    start: {
      title: "Hyr",
      subtitle: "Përdor llogarinë që të krijoi ekipi yt.",
      actionText: "Nuk ke llogari?",
      actionLink: "Regjistrohu",
      actionLink__use_username: "Hyr me emrin e përdoruesit",
    },
    password: { title: "Shkruaj fjalëkalimin", subtitle: "", actionLink: "Përdor një mënyrë tjetër" },
    passwordPwned: { title: "Ky fjalëkalim nuk është i sigurt" },
    forgotPasswordAlternativeMethods: {
      title: "Harrove fjalëkalimin?",
      label__alternativeMethods: "Ose hyr me një mënyrë tjetër",
      blockButton__resetPassword: "Rivendos fjalëkalimin",
    },
    forgotPassword: {
      title: "Rivendos fjalëkalimin",
      subtitle: "për të rivendosur fjalëkalimin",
      formTitle: "Kodi i verifikimit",
      resendButton: "Nuk të erdhi kodi? Dërgoje përsëri",
    },
    resetPassword: {
      title: "Vendos një fjalëkalim të ri",
      formButtonPrimary: "Rivendos fjalëkalimin",
      successMessage: "Fjalëkalimi u ndryshua me sukses. Po të fusim në llogari…",
      requiredMessage: "Për arsye sigurie duhet të rivendosësh fjalëkalimin.",
    },
    totpMfa: {
      title: "Verifikimi në dy hapa",
      subtitle: "Shkruaj kodin nga aplikacioni i autentifikimit për të vazhduar.",
      formTitle: "Kodi i verifikimit",
    },
    backupCodeMfa: {
      title: "Shkruaj një kod rezervë",
      subtitle: "Përdor një nga kodet rezervë që ruajte kur aktivizove verifikimin në dy hapa.",
    },
    alternativeMethods: {
      title: "Përdor një mënyrë tjetër",
      subtitle: "Ke probleme? Mund të hysh me një nga këto mënyra.",
      actionLink: "Merr ndihmë",
      actionText: "Nuk ke asnjë nga këto?",
      blockButton__password: "Hyr me fjalëkalimin",
      blockButton__totp: "Përdor aplikacionin e autentifikimit",
      blockButton__backupCode: "Përdor një kod rezervë",
      getHelp: {
        title: "Merr ndihmë",
        content: "Nëse nuk mund të hysh në llogari, kontakto Menaxherin ose Pronarin tënd.",
        blockButton__emailSupport: "Shkruaji mbështetjes",
      },
    },
    noAvailableMethods: {
      title: "Nuk mund të hysh",
      subtitle: "Ndodhi një gabim",
      message: "Nuk mund të vazhdosh me hyrjen. Asnjë mënyrë hyrjeje nuk është e disponueshme.",
    },
  },
  unstable__errors: {
    form_identifier_not_found: "Nuk u gjet asnjë llogari me këtë emër përdoruesi.",
    form_password_incorrect: "Fjalëkalimi është i gabuar. Provo përsëri.",
    form_password_pwned: "Ky fjalëkalim është gjetur në një rrjedhje të dhënash dhe nuk mund të përdoret. Zgjidh një tjetër.",
    form_password_pwned__sign_in: "Ky fjalëkalim është gjetur në një rrjedhje të dhënash. Rivendose fjalëkalimin.",
    form_password_validation_failed: "Fjalëkalimi është i gabuar.",
    form_code_incorrect: "Kodi është i gabuar.",
    form_param_nil: "Kjo fushë është e detyrueshme.",
    form_param_format_invalid: "Formati nuk është i vlefshëm.",
    not_allowed_access: "Nuk ke leje të hysh.",
    session_exists: "Je futur tashmë.",
    captcha_invalid: "Verifikimi i sigurisë dështoi. Rifresko faqen dhe provo përsëri.",
  },
};

export function clerkLocalization(lang: Lang): ClerkLocalization {
  return lang === "sq" ? sq : en;
}
