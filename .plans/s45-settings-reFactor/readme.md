Settings Webmail UI needs a revamp. 

Settings Column is different than the hierarchy used in mail and other realms where they use:
`CategoryColumn > CollectionColumn > ItemDisplay` -> `Inbox > the list of messages > messageItem`

Settings will have a "SettingsColumn" which would have Inlined-Hierarch in something like a ColelctionColumn...

So in the `SettingsColumn` the Top Level Headers are not clickable and they are sticky-placed on the screen as a user scrolls the menu.





1. Identity {<- non-clickable header value with sticky positioning }
    - From 
        - Display
        - Sending Address
        - Reply-To
    - Always BCC
    - Signatures
        - HTML
        - Plain Text
2. Out of Office {<- non-clickable header value with sticky positioning }
    - Send Auto Reply
    - Subject
    - Message
    - Start
    - End
3. Agents {<- non-clickable header value with sticky positioning }
    - Default Monthly Budget
    - Explore Rate = 20%
    - List of Agents Status
        - Enable/Disabel
        - Budget Edit
4. Tokens
    - list of Named Tokens 
        - actions: rename | revoke
    - BulkActions:
        - revoke
5. Devices {<- non-clickable header value with sticky positioning }
    - Install Command
    - List of CLI installations
        - last heartbeat timeAgo (secAgo, s%60=minAgo, s%3600 = HoursAgo, s%86400 = DaysAgo)
    - Models Available
        - via CLI Installation Reference 
    - Capabilities Available
        - via CLI Installation Reference
