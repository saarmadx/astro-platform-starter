/// <reference types="astro/client" />

declare namespace App {
    interface Locals {
        user: { uid: string; name: string } | null;
        isAdmin: boolean;
    }
}
