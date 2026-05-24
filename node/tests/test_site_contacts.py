"""Tests for operator contact email / display name settings."""
import unittest
from unittest import mock

from site_contacts import (
    DEFAULT_EMAILS,
    normalize_email,
    resolve_contact_email,
    set_operator_site_settings,
    substitute_contacts_in_text,
    validate_email,
    vapid_claims,
)


class SiteContactsTests(unittest.TestCase):
    def test_validate_email(self):
        self.assertIsNone(validate_email("security@example.com"))
        self.assertIsNotNone(validate_email("not-an-email"))

    def test_resolve_prefers_db(self):
        with mock.patch("site_contacts._db_email", return_value="ops@node.test"):
            self.assertEqual(resolve_contact_email("security"), "ops@node.test")

    def test_substitute_contacts(self):
        with mock.patch("site_contacts.resolve_site_contacts", return_value={
            "security": "sec@custom.test",
            "privacy": DEFAULT_EMAILS["privacy"],
            "support": DEFAULT_EMAILS["support"],
            "vapid": DEFAULT_EMAILS["vapid"],
        }):
            out = substitute_contacts_in_text("Email security@frogtalk.xyz for help")
            self.assertIn("sec@custom.test", out)
            self.assertNotIn("security@frogtalk.xyz", out)

    def test_vapid_claims_uses_resolver(self):
        with mock.patch("site_contacts.resolve_contact_email", return_value="push@node.test"):
            self.assertEqual(vapid_claims(), {"sub": "mailto:push@node.test"})

    def test_set_rejects_invalid(self):
        with mock.patch("site_contacts.db", create=True):
            with mock.patch("database.set_config"):
                result = set_operator_site_settings(security_email="bad")
                self.assertFalse(result.get("ok"))

    def test_normalize_lowercase(self):
        self.assertEqual(normalize_email("  Hello@Example.COM "), "hello@example.com")


if __name__ == "__main__":
    unittest.main()
